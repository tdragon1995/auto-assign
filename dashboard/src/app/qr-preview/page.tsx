import { Suspense } from "react";
import PreviewClient from "./preview-client";

export const dynamic = "force-dynamic";

export default function Page() {
  return (
    <Suspense>
      <PreviewClient />
    </Suspense>
  );
}
