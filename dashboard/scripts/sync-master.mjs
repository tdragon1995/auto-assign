// Reuse the morning workflow; bounded batches keep each Vercel request short.
import { pathToFileURL } from "node:url";

export async function runMasterSync(baseUrl = "https://diag-logistics.vercel.app", request = fetch) {
  const call = async (path, method = "POST") => {
    const response = await request(`${baseUrl}${path}`, {method, signal: AbortSignal.timeout(295_000)});
    const data = await response.json();
    if (!response.ok || data.ok === false || data.status === "error") throw new Error(data.error || `Sync HTTP ${response.status}`);
    return data;
  };
  const profiles = await call("/api/master-client-info/sync?phase=profiles");
  if (profiles.ok !== true) throw new Error("Cartrack sync did not complete");
  let after = "", processed = 0, issues = 0;
  for (let batch = 0; batch < 80; batch++) {
    const data = await call(`/api/master-client-info/sync?phase=metadata&limit=100&after=${encodeURIComponent(after)}`);
    const report = data.labcenter;
    if (data.ok !== true || !report || !Number.isInteger(report.processed) || report.processed < 0 || !Array.isArray(report.issues)) throw new Error("Labcenter sync did not complete");
    processed += report.processed;
    issues += report.issues.length;
    if (!report.nextCursor) {
      await call("/api/config", "GET");
      console.log(`Morning sync complete: ${processed} Labcenter client codes; ${issues} review issues`);
      return {processed, issues};
    }
    if (!/^\d+$/.test(report.nextCursor) || report.nextCursor <= after) throw new Error("Labcenter sync cursor did not advance");
    after = report.nextCursor;
  }
  throw new Error("Labcenter sync exceeded 80 batches; completed batches are retained");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runMasterSync().catch(error => { console.error(error.message); process.exitCode = 1; });
}
