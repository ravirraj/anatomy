import { createAdminSupabase } from "./admin.ts";
import type { Database } from "./database.types.ts";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Cache } from "../ai/tasks.ts";

type Db = SupabaseClient<Database>;

// Reads go through the member's client and its policy. Members have no write
// grant, so answers are stored by the server's writer, stamped with the
// organization the policy just let the member read.
export function createAiCache(db: Db, organizationId: string): Cache {
  return {
    async read(key) {
      const { data, error } = await db.from("ai_cache").select("body").eq("key", key).maybeSingle();
      if (error) throw new Error(`Reading the cache failed: ${error.message}`);
      return data?.body ?? null;
    },
    async write({ key, task, model, body }) {
      const { error } = await createAdminSupabase()
        .from("ai_cache")
        .upsert(
          { organization_id: organizationId, key, task, model, body },
          { onConflict: "organization_id,key", ignoreDuplicates: true },
        );
      if (error) throw new Error(`Storing the answer in the cache failed: ${error.message}`);
    },
    // The server's writer removes the entry too: members have no delete grant.
    // Cheapest healing for an invalid cached answer is dropping its own row.
    async delete(key) {
      const { error } = await createAdminSupabase()
        .from("ai_cache")
        .delete()
        .eq("organization_id", organizationId)
        .eq("key", key);
      if (error) throw new Error(`Deleting the cached answer failed: ${error.message}`);
    },
  };
}
