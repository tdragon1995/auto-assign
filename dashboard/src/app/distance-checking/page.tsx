import { DistanceCheckingPanel } from "@/components/distance-checking-panel";

// Standalone route for the lat/long pair distance checker. The same panel is
// also embedded in the main dashboard's "Distance checking" tab.
export default function DistanceCheckingPage() {
  return (
    <div className="min-h-screen bg-slate-50">
      <DistanceCheckingPanel />
    </div>
  );
}
