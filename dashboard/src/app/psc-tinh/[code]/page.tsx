import PscTinhPage from "./psc-tinh-client";

// Static shell: the page is entirely client-side (TPL options and orders load
// from /api/psc-tinh in the browser), so serve it from the CDN instead of
// invoking a function on every scan. Codes mirror PSC_META in
// psc-tinh-client.tsx — add new provincial PSCs in both places. Unknown or
// lowercase codes still render on demand and resolve client-side.
export const dynamic = "force-static";

export function generateStaticParams() {
  return ["D021", "D023", "D030", "D036"].map((code) => ({ code }));
}

export default function Page() {
  return <PscTinhPage />;
}
