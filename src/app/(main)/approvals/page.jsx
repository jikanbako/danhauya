"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import axios from "axios";
import toast from "react-hot-toast";
import Badge from "@/components/ui/Badge";
import { formatNaira } from "@/utils/formatNaira";
import { formatDate } from "@/utils/formatDate";
import { useAuthStore } from "@/store/authStore";
import { ROLES } from "@/constants/roles";
import styles from "./page.module.css";

export default function ApprovalsQueuePage() {
  const user = useAuthStore((s) => s.user);
  const searchParams = useSearchParams();
  const requestedStage = searchParams.get("stage");
  const isProcurement = user?.role === ROLES.PROCUREMENT;
  const stage = isProcurement ? (requestedStage || "market-survey") : "current";

  const [requisitions, setRequisitions] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    axios
      .get("/api/approvals", { params: { stage } })
      .then(({ data }) => setRequisitions(data.requisitions || []))
      .catch((err) => toast.error(err.response?.data?.message || "Failed to load queue."))
      .finally(() => setLoading(false));
  }, [stage]);

  const title = isProcurement
    ? stage === "processing" ? "Procurement Processing Queue" : stage === "awaiting-vc" ? "Awaiting VC" : "Procurement Market Survey"
    : "Approvals Queue";

  const subtitle = isProcurement
    ? stage === "processing"
      ? "VC-approved requisitions assigned to you for procurement processing."
      : stage === "awaiting-vc"
        ? "Market-surveyed requisitions currently with the VC."
        : "Requisitions waiting for Procurement to complete market survey and BOQ pricing."
    : "Requisitions currently awaiting your decision.";

  return (
    <div className={styles.wrapper}>
      <h1 className={styles.heading}>{title}</h1>
      <p className={styles.subheading}>{subtitle}</p>

      {isProcurement && (
        <div className={styles.tabs}>
          <Link className={stage === "market-survey" ? styles.tabActive : styles.tab} href="/approvals?stage=market-survey">Market Survey</Link>
          <Link className={stage === "awaiting-vc" ? styles.tabActive : styles.tab} href="/approvals?stage=awaiting-vc">Awaiting VC</Link>
          <Link className={stage === "processing" ? styles.tabActive : styles.tab} href="/approvals?stage=processing">Processing</Link>
        </div>
      )}

      {loading ? (
        <p className={styles.hint}>Loading…</p>
      ) : requisitions.length === 0 ? (
        <p className={styles.hint}>Nothing is waiting in this queue right now.</p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Requisition No.</th>
                <th>Requester</th>
                <th>Department</th>
                <th>{isProcurement && stage === "processing" ? "Current Cost" : "Estimated Cost"}</th>
                <th>Status</th>
                <th>Date</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {requisitions.map((r) => (
                <tr key={r._id}>
                  <td className="mono">{r.requisitionNumber}</td>
                  <td>{r.requester?.fullName || "—"}</td>
                  <td>{r.department || "—"}</td>
                  <td className="mono">{formatNaira(r.estimatedCost)}</td>
                  <td><Badge status={r.status} /></td>
                  <td>{formatDate(r.updatedAt || r.submittedAt)}</td>
                  <td><Link href={`/approvals/${r._id}`} className={styles.reviewLink}>{stage === "processing" ? "Open" : stage === "awaiting-vc" ? "View" : "Review"}</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
