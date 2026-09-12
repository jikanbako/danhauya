"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import axios from "axios";

import StatCard from "@/components/ui/StatCard";
import Button from "@/components/ui/Button";
import { PROCUREMENT_POSITIONS } from "@/constants/procurement";

import styles from "./dashboard-grid.module.css";

export default function ProcurementDashboard({ user }) {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadDashboard() {
      try {
        const { data } = await axios.get("/api/dashboard");
        setStats(data);
      } catch (error) {
        console.error("Failed to load Procurement dashboard:", error);
      } finally {
        setLoading(false);
      }
    }
    loadDashboard();
  }, []);

  const isDirector = user?.procurementPosition === PROCUREMENT_POSITIONS.DIRECTOR;
  const isAssignmentManager =
    user?.procurementPosition === PROCUREMENT_POSITIONS.DIRECTOR ||
    user?.procurementPosition === PROCUREMENT_POSITIONS.PRINCIPAL_SENIOR;

  return (
    <div className={styles.wrapper}>
      <div>
        <h1 className={styles.heading}>
          Welcome, {user.fullName.split(" ")[0]}
        </h1>
        <p className={styles.subheading}>
          {user?.procurementPositionLabel || "Procurement Directorate Staff"}
        </p>
      </div>

      <div className={styles.actions}>
        <Link href="/approvals?stage=current">
          <Button>
            <i className="bi bi-inbox" /> {isDirector ? "Procurement Intake" : "My Market Survey Queue"}
          </Button>
        </Link>
        {isAssignmentManager && (
          <Link href="/approvals?stage=current">
            <Button variant="secondary">
              <i className="bi bi-person-check" /> Assign Market Survey
            </Button>
          </Link>
        )}
        <Link href="/approvals?stage=awaiting-vc">
          <Button variant="secondary">
            <i className="bi bi-building-up" /> Awaiting VC
          </Button>
        </Link>
        <Link href="/approvals?stage=processing">
          <Button variant="secondary">
            <i className="bi bi-gear" /> Processing
          </Button>
        </Link>
        <Link href="/approvals?stage=rejected">
          <Button variant="secondary">
            <i className="bi bi-x-circle" /> Rejected
          </Button>
        </Link>
      </div>

      <div className={styles.statGrid}>
        <StatCard
          label={isDirector ? "Procurement Intake" : "My Market Survey Queue"}
          value={loading ? "..." : stats?.marketSurveyCount ?? 0}
          icon="bi-inbox"
          tone="pending"
        />
        <StatCard
          label="Awaiting VC"
          value={loading ? "..." : stats?.awaitingVcCount ?? 0}
          icon="bi-building-up"
          tone="pending"
        />
        <StatCard
          label="Ready for Processing"
          value={loading ? "..." : stats?.readyForProcurement ?? 0}
          icon="bi-box-seam"
          tone="approved"
        />
        <StatCard
          label="Processing"
          value={loading ? "..." : stats?.processingCount ?? 0}
          icon="bi-hourglass-split"
          tone="pending"
        />
        <StatCard
          label="Processing Completed"
          value={loading ? "..." : stats?.completedCount ?? 0}
          icon="bi-check-circle"
          tone="approved"
        />
        <StatCard
          label="Rejected"
          value={loading ? "..." : stats?.rejectedCount ?? 0}
          icon="bi-x-circle"
          tone="rejected"
        />
        <StatCard
          label="Total Procurement Items"
          value={loading ? "..." : stats?.totalProcurementItems ?? 0}
          icon="bi-clipboard-data"
          tone="primary"
        />
      </div>
    </div>
  );
}
