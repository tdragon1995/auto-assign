import { CompletedExportPanel } from "@/components/completed-export-panel";

// Standalone route for the completed-jobs export. The same panel is also
// embedded in the main dashboard's "Distance checking" tab.
export default function ExportCompletedPage() {
  return (
    <div className="min-h-screen bg-slate-50">
      <CompletedExportPanel env="prod" />
    </div>
  );
}
