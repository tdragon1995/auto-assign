import { Suspense } from "react";
import { PSC_ROUTES } from "@/lib/psc-routes-data";
import QrPage from "./qr-client";

// Static shell: the page is entirely client-side (data loads from
// /api/location-jobs in the browser), so serve it from the CDN instead of
// invoking a function on every scan. All known location codes are prebuilt at
// deploy; unknown codes still render on demand (and show the client's
// "not found" state).
export const dynamic = "force-static";

export function generateStaticParams() {
  return PSC_ROUTES.map((r) => ({ code: r.pickup }));
}

export default function Page() {
  // Suspense boundary for the statically-rendered client component.
  return (
    <Suspense>
      <QrPage />
    </Suspense>
  );
}
