// Phase 2 — deterministic question planner tests.
// Every category from the plan: normal concept questions, ambiguous short
// words, generic-verb-dominated questions, out-of-vocabulary questions, and
// the authorize/authorization prefix-family fix.

import {
  planQuestion,
} from "../lib/ai/planner.ts";
import { sameFamily, tokenVariants } from "../lib/ai/retrieval.ts";

let passed = 0;
let failed = 0;
function pass(name: string) { passed++; console.log("ok   ", name); }
function fail(name: string, detail: string) { failed++; console.log("FAIL ", name, "-", detail); }
function check(name: string, ok: boolean, detail: string) {
  if (ok) pass(name); else fail(name, detail);
}

const plans: Record<string, ReturnType<typeof planQuestion>> = {};

// --- 1. Normal question -----------------------------------------------------
{
  const plan = planQuestion("How does authentication work?");
  plans.auth = plan;
  check(
    "auth question plans the authentication concept",
    plan.concepts.length === 1 && plan.concepts[0]?.token === "authentication",
    JSON.stringify(plan.concepts.map((c) => c.token)),
  );
  const variants = plan.concepts[0]?.variants.map((v) => `${v.text}:${v.source}`) ?? [];
  check(
    "auth concept variants carry sources (direct/stem/glossary)",
    variants.some((v) => v.startsWith("authentication:direct"))
      && variants.some((v) => v.includes(":glossary")),
    variants.join(", "),
  );
  check(
    "auth concept no longer leaks the authorization family",
    !variants.some((v) => v.startsWith("authorization:")),
    variants.join(", "),
  );
  check(
    "auth question expects controller/middleware/model/frontend evidence",
    ["controllers", "middleware", "models", "frontend"].every((c) =>
      plan.expectedEvidence.includes(c)),
    plan.expectedEvidence.join(", "),
  );
  check(
    "auth question intent is explain-subsystem",
    plan.intent === "explain-subsystem",
    `${plan.intent} (${plan.intentReason})`,
  );
  check(
    "auth question marks question-word fillers as unused",
    plan.unusedTokens.some((u) => u.word === "work" && u.reason === "stop-word"),
    JSON.stringify(plan.unusedTokens),
  );
  check("auth question is answerable", plan.isAnswerable, "not answerable");
}

// --- 2. Usage / integration question ---------------------------------------
{
  const plan = planQuestion("How does the SDK work, and how does a developer use the SDK to integrate with it?");
  plans.sdk = plan;
  check(
    "sdk question intent is usage-integration",
    plan.intent === "usage-integration",
    `${plan.intent} (${plan.intentReason})`,
  );
  const tokens = plan.concepts.map((c) => c.token);
  check(
    "sdk question keeps sdk and developer as concepts",
    tokens.includes("sdk") && tokens.includes("developer"),
    tokens.join(", "),
  );
  const sdkVariants = plan.concepts.find((c) => c.token === "sdk")?.variants.map((v) => v.text) ?? [];
  check(
    "sdk concept expands to generic client/package/library vocabulary",
    ["client", "packages", "library"].every((v) => sdkVariants.includes(v)),
    sdkVariants.join(", "),
  );
  check(
    "sdk question expects routes/controllers/frontend evidence",
    ["routes", "controllers", "frontend"].every((c) => plan.expectedEvidence.includes(c)),
    plan.expectedEvidence.join(", "),
  );
  check(
    "no generic verb became a concept",
    !plan.concepts.some((c) => ["implement", "handle", "create"].includes(c.token)),
    plan.concepts.map((c) => c.token).join(", "),
  );
}

// --- 3. Ambiguous short word ------------------------------------------------
{
  const plan = planQuestion("auth");
  plans.shortAuth = plan;
  check(
    "bare \"auth\" stays one ambiguous concept",
    plan.concepts.length === 1 && plan.concepts[0]?.token === "auth",
    JSON.stringify(plan.concepts.map((c) => c.token)),
  );
  const texts = plan.concepts[0]?.variants.map((v) => v.text) ?? [];
  check(
    "bare \"auth\" expands across both identity and access clusters",
    texts.includes("authentication") && texts.includes("authorization"),
    texts.join(", "),
  );
  check(
    "bare \"auth\" intent defaults to subsystem explanation",
    plan.intent === "explain-subsystem",
    `${plan.intent} (${plan.intentReason})`,
  );
}

// --- 4. Generic-verb-dominated question -------------------------------------
{
  const plan = planQuestion("How do you implement and handle errors properly?");
  plans.generic = plan;
  const tokens = plan.concepts.map((c) => c.token);
  check(
    "implement and handle are stripped from concepts",
    !tokens.includes("implement") && !tokens.includes("handle"),
    tokens.join(", "),
  );
  check(
    "errors remain the only concept",
    tokens.length === 1 && tokens[0] === "errors",
    tokens.join(", "),
  );
  const unused = plan.unusedTokens.filter((u) => u.reason === "generic-verb").map((u) => u.word);
  check(
    "generic verbs are recorded as unused with sources",
    unused.includes("implement") && unused.includes("handle"),
    unused.join(", "),
  );
  check(
    "error handling expects middleware/services/frontend evidence",
    plan.expectedEvidence.includes("middleware") && plan.expectedEvidence.includes("frontend"),
    plan.expectedEvidence.join(", "),
  );
}

// --- 5. Out-of-vocabulary question ------------------------------------------
{
  const plan = planQuestion("why is my coffee bitter");
  plans.ool = plan;
  check(
    "out-of-vocabulary question keeps its concepts but with no glossary aid",
    plan.concepts.every((c) => c.variants.every((v) => v.source === "direct")),
    JSON.stringify(plan.concepts.flatMap((c) => c.variants.map((v) => `${c.token}=${v.text}:${v.source}`))),
  );
  check(
    "out-of-vocabulary question expects no category evidence",
    plan.expectedEvidence.length === 0,
    plan.expectedEvidence.join(", "),
  );
  check(
    "out-of-vocabulary why-question is classified as diagnosis",
    plan.intent === "diagnose-behavior",
    `${plan.intent} (${plan.intentReason})`,
  );
  check(
    "out-of-vocabulary question is still answerable-shaped (concepts exist)",
    plan.isAnswerable,
    "should stay answerable-shaped; coverage evaluator decides",
  );
}

// --- 6. Intent variety -------------------------------------------------------
{
  const plan = planQuestion("where is the session persistence implemented?");
  check(
    "where-question is locate-implementation",
    plan.intent === "locate-implementation",
    `${plan.intent} (${plan.intentReason})`,
  );
  const flow = planQuestion("trace the flow of the login request end to end");
  check(
    "flow-question is trace-flow",
    flow.intent === "trace-flow",
    `${flow.intent} (${flow.intentReason})`,
  );
  const fn = planQuestion("What does verifyJWT do?");
  check(
    "explicit function question is explain-function",
    fn.intent === "explain-function",
    `${fn.intent} (${fn.intentReason})`,
  );
  const arch = planQuestion("Give me an overview of the codebase structure");
  check(
    "overview question is explain-architecture",
    arch.intent === "explain-architecture",
    `${arch.intent} (${arch.intentReason})`,
  );
  const empty = planQuestion("!!!");
  check(
    "gibberish question is not answerable",
    !empty.isAnswerable && empty.concepts.length === 0,
    JSON.stringify(empty.concepts),
  );
}

// --- 7. Plan explains itself -------------------------------------------------
{
  const plan = plans.sdk ?? planQuestion("How does the SDK work?");
  const printable = JSON.stringify(plan, null, 1);
  check(
    "plan output is plain serialisable data (explainable)",
    printable.includes("\"source\": \"glossary\"")
      && printable.includes("intentReason")
      && printable.includes("expectedEvidence"),
    printable.slice(0, 120) + "…",
  );
}

// --- 8. family/prefix unit checks --------------------------------------------
{
  check(
    "authorize is NOT in the auth word family (leak fixed)",
    !sameFamily("authorize", "auth"),
    "sameFamily says yes",
  );
  check(
    "authenticate IS in the authentication word family",
    sameFamily("authenticate", "authentication"),
    "sameFamily says no",
  );
  check(
    "authorize IS in the authorization word family",
    sameFamily("authorize", "authorization"),
    "sameFamily says no",
  );
  check(
    "configuration is not a prefix family of config (glossary handles it)",
    !sameFamily("configuration", "config"),
    "sameFamily says yes",
  );
  // One-sided tails must be true inflections, not loose 2-char suffixes:
  // "auth" extended by the word-author suffix "or" is a different word.
  check(
    "user ~ users is an inflection family",
    sameFamily("user", "users"),
    "sameFamily says no",
  );
  check(
    "authorize ~ authorized is an inflection family",
    sameFamily("authorize", "authorized"),
    "sameFamily says no",
  );
  check(
    "database ~ databases is an inflection family",
    sameFamily("database", "databases"),
    "sameFamily says no",
  );
  check(
    "checkout ~ checkouts is an inflection family",
    sameFamily("checkout", "checkouts"),
    "sameFamily says no",
  );
  check(
    "auth is NOT in the author word family (extension 'or' is not an inflection)",
    !sameFamily("auth", "author"),
    "sameFamily says yes",
  );
  check(
    "auth is NOT in the authorizer word family (extension 'orizer' is not an inflection)",
    !sameFamily("auth", "authorizer"),
    "sameFamily says yes",
  );
  check(
    "gate is NOT in the gateway word family (extension 'way' is not an inflection)",
    !sameFamily("gate", "gateway"),
    "sameFamily says yes",
  );
  // Accepted trade-off of the strict one-sided rule: agentive 1-2 char tails
  // ("scheduler" of "schedule") no longer family-match; exact and stem
  // variants still cover those cases.
  check(
    "schedule is NOT in the scheduler word family (strict one-sided inflections only)",
    !sameFamily("schedule", "scheduler"),
    "sameFamily says yes",
  );
  const authVariants = tokenVariants("authentication").map((v) => v.text);
  check(
    "authentication query variants no longer contain authorization",
    !authVariants.includes("authorization"),
    JSON.stringify(authVariants),
  );
  check(
    "authorization query variants contain authorize",
    tokenVariants("authorization").map((v) => v.text).includes("authorize"),
    "missing authorize",
  );
}

// --- 9. CLI execution vs UI/component intent & coverage ---------------------
{
  const cliPlan = planQuestion("Trace the complete flow when a user runs lithos add button, from command parsing to component installation.");
  check(
    "command parsing flow question plans as cli-execution without literal word CLI",
    cliPlan.intent === "cli-execution",
    `${cliPlan.intent} (${cliPlan.intentReason})`,
  );
  check(
    "command parsing flow expects CLI evidence",
    cliPlan.expectedEvidence.includes("cli"),
    cliPlan.expectedEvidence.join(", "),
  );

  const cliPlan2 = planQuestion("How are subcommands dispatched from commandline arguments?");
  check(
    "subcommand dispatch question plans as cli-execution",
    cliPlan2.intent === "cli-execution" && cliPlan2.expectedEvidence.includes("cli"),
    `${cliPlan2.intent}`,
  );

  const installPlan = planQuestion("How do I install a component?");
  check(
    "ordinary component install question stays usage-integration (not cli-execution)",
    installPlan.intent === "usage-integration",
    `${installPlan.intent} (${installPlan.intentReason})`,
  );
  check(
    "ordinary component install question does not expect cli evidence",
    !installPlan.expectedEvidence.includes("cli"),
    installPlan.expectedEvidence.join(", "),
  );

  const buttonPlan = planQuestion("How does the Button component work?");
  check(
    "ordinary UI Button question stays explain-subsystem (not cli-execution)",
    buttonPlan.intent === "explain-subsystem",
    `${buttonPlan.intent} (${buttonPlan.intentReason})`,
  );
  check(
    "ordinary UI Button question does not expect cli evidence",
    !buttonPlan.expectedEvidence.includes("cli"),
    buttonPlan.expectedEvidence.join(", "),
  );

  const addButtonPlan = planQuestion("How do I add a Button to my page?");
  check(
    "add button to page question is usage-integration and does not expect cli evidence",
    addButtonPlan.intent === "usage-integration" && !addButtonPlan.expectedEvidence.includes("cli"),
    `${addButtonPlan.intent}`,
  );
}

// --- Summary -----------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
export {};
