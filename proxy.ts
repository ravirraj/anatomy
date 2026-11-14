import { clerkMiddleware } from "@clerk/nextjs/server";

const isPublicRoute = (pathname: string) =>
  pathname.startsWith("/sign-in") || pathname.startsWith("/sign-up");

// Protection happens here, before any route renders, so a signed-out visitor
// gets a redirect and never receives the page's HTML.
export default clerkMiddleware(async (auth, req) => {
  if (!isPublicRoute(req.nextUrl.pathname)) await auth.protect();
});

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
    "/__clerk/:path*",
  ],
};
