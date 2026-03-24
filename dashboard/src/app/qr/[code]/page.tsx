"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

interface PscRoute {
  psc_pickup: string;
  dropoff_location: string;
  pickup: string;
  dropoff: string;
  ref_number: string;
  driver_id: string | null;
  driver_name: string | null;
}

type Status = "idle" | "loading" | "success" | "error";

export default function QrPage() {
  const params = useParams<{ code: string }>();
  const code = decodeURIComponent(params.code ?? "").toUpperCase().trim();

  const [route, setRoute] = useState<PscRoute | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  const [assignStatus, setAssignStatus] = useState<Status>("idle");
  const [assignResult, setAssignResult] = useState<string>("");

  const [duplicateRef, setDuplicateRef] = useState<string | null>(null);
  const [duplicateChecking, setDuplicateChecking] = useState(false);

  // Fetch the route data, then check for duplicates with live polling
  useEffect(() => {
    fetch("/api/psc-routes")
      .then((r) => r.json())
      .then((d) => {
        const routes: PscRoute[] = d.data ?? [];
        const match = routes.find(
          (r) => r.psc_pickup.toUpperCase() === code
        );
        if (match) {
          setRoute(match);

          const checkDuplicate = () => {
            setDuplicateChecking(true);
            fetch(`/api/check-duplicate?pickup=${match.pickup}&dropoff=${match.dropoff}`)
              .then((r) => r.json())
              .then((d) => { if (d.blocked) setDuplicateRef(d.reference); else setDuplicateRef(null); })
              .finally(() => setDuplicateChecking(false));
          };

          checkDuplicate();
          const interval = setInterval(checkDuplicate, 30_000);
          return () => clearInterval(interval);
        } else {
          setNotFound(true);
        }
        setLoading(false);
      })
      .catch(() => {
        setNotFound(true);
        setLoading(false);
      });
  }, [code]);

  const handleAssign = async () => {
    if (!route) return;
    setAssignStatus("loading");
    setAssignResult("");

    try {
      const res = await fetch("/api/psc-assign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          psc_pickup: route.psc_pickup,
          dropoff_location: route.dropoff_location,
          pickup: route.pickup,
          dropoff: route.dropoff,
          ref_number: route.ref_number,
        }),
      });

      const data = await res.json();

      if (res.ok && data.success) {
        setAssignStatus("success");
        setAssignResult(`Job submitted → ${data.reference}`);
      } else {
        setAssignStatus("error");
        setAssignResult(data.error || "Unknown error");
      }
    } catch (e) {
      setAssignStatus("error");
      setAssignResult(String(e));
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-background">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  if (notFound) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-background p-4">
        <Card className="max-w-sm w-full">
          <CardHeader>
            <CardTitle className="text-destructive">Not Found</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground">
              No PSC route found for code <strong>{code}</strong>.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-center min-h-screen bg-background p-4">
      <Card className="max-w-md w-full">
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            PSC Transport
            <Badge variant="outline">{route!.psc_pickup}</Badge>
          </CardTitle>
        </CardHeader>

        <CardContent className="space-y-4">
          {/* Route info */}
          <div className="rounded-lg border p-4 space-y-3">
            <Row label="Pickup" value={`${route!.psc_pickup}`} icon="📦" />
            <Row
              label="Dropoff"
              value={`${route!.dropoff_location}`}
              icon="📍"
            />
            <Row
              label="Route"
              value={`${route!.psc_pickup} ➡ ${route!.dropoff_location}`}
              icon="🛵"
            />
            {route!.ref_number && (
              <Row label="Ref" value={route!.ref_number} icon="🏷️" />
            )}
          </div>

          {/* Duplicate warning */}
          {duplicateChecking && (
            <div className="rounded-lg border border-yellow-200 bg-yellow-50 p-4 text-sm text-yellow-800">
              Checking for existing jobs today...
            </div>
          )}
          {duplicateRef && (
            <div className="rounded-lg border border-orange-200 bg-orange-50 p-4 text-sm text-orange-800">
              ⚠️ A job for this route already exists today ({duplicateRef}). Cannot create a duplicate.
            </div>
          )}

          {/* Assignment result */}
          {assignStatus === "success" && (
            <div className="rounded-lg border border-green-200 bg-green-50 p-4 text-sm text-green-800">
              {assignResult}
            </div>
          )}
          {assignStatus === "error" && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
              {assignResult}
            </div>
          )}
        </CardContent>

        <CardFooter className="flex flex-col gap-2">
          <Button
            className="w-full"
            size="lg"
            onClick={handleAssign}
            disabled={
              !!duplicateRef ||
              duplicateChecking ||
              assignStatus === "loading" ||
              assignStatus === "success"
            }
          >
            {assignStatus === "loading"
              ? "Creating job..."
              : assignStatus === "success"
                ? "Job created"
                : "Assign & Create Job"}
          </Button>
          {assignStatus === "success" && (
            <Button
              variant="outline"
              className="w-full"
              onClick={() => {
                setAssignStatus("idle");
                setAssignResult("");
              }}
            >
              Create another
            </Button>
          )}
        </CardFooter>
      </Card>
    </div>
  );
}

function Row({
  label,
  value,
  icon,
  mono,
}: {
  label: string;
  value: string;
  icon: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-muted-foreground flex items-center gap-1.5">
        <span>{icon}</span>
        {label}
      </span>
      <span className={mono ? "font-mono text-xs" : "font-medium"}>
        {value}
      </span>
    </div>
  );
}
