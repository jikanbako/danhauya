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
  const requestedAction = searchParams.get("action");
  const isProcurement = user?.role === ROLES.PROCUREMENT;
  const canSeeMyDecisions = [ROLES.HOD, ROLES.DEAN, ROLES.PROVOST, ROLES.VC, ROLES.PROCUREMENT].includes(user?.role);
  const stage = isProcurement ? (requestedStage || "market-survey") : (requestedStage || "current");
  const decisionAction = ["approve", "return", "reject"].includes(requestedAction) ? requestedAction : "all";

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

  const title = stage === "my-decisions"
    ? decisionAction === "approve" ? "Approved by Me" : decisionAction === "return" ? "Returned by Me" : decisionAction === "reject" ? "Rejected by Me" : "My Decisions"
    : isProcurement
      ? stage === "processing" ? "Procurement Processing Queue" : stage === "awaiting-vc" ? "Awaiting VC" : stage === "director-review" ? "Director Review" : "Procurement Market Survey"
      : "Approvals Queue";

  const subtitle = stage === "my-decisions"
    ? "Requisitions where you personally approved, returned, or rejected a workflow step."
    : isProcurement
      ? stage === "processing"
        ? "VC-approved requisitions assigned to you for procurement processing."
        : stage === "awaiting-vc"
          ? "Market-surveyed requisitions currently with the VC."
          : stage === "director-review"
            ? "Completed market surveys waiting for the Procurement Director's review before they are sent to the VC."
            : "Requisitions waiting for Procurement to complete market survey and BOQ pricing."
      : "Requisitions currently awaiting your decision.";

  return (
    <div className={styles.wrapper}>
      <h1 className={styles.heading}>{title}</h1>
      <p className={styles.subheading}>{subtitle}</p>

      <div className={styles.tabs} aria-label="Approval queues">
        {!isProcurement && (
          <Link
            className={stage === "current" ? styles.tabActive : styles.tab}
            href="/approvals?stage=current"
          >
            Current Approvals
          </Link>
        )}

        {isProcurement && (
          <>
            <Link
              className={stage === "market-survey" ? styles.tabActive : styles.tab}
              href="/approvals?stage=market-survey"
            >
              Market Survey
            </Link>
            <Link
              className={stage === "awaiting-vc" ? styles.tabActive : styles.tab}
              href="/approvals?stage=awaiting-vc"
            >
              Awaiting VC
            </Link>
            {user?.procurementPosition === "director" && (
              <Link
                className={stage === "director-review" ? styles.tabActive : styles.tab}
                href="/approvals?stage=director-review"
              >
                Director Review
              </Link>
            )}
            <Link
              className={stage === "processing" ? styles.tabActive : styles.tab}
              href="/approvals?stage=processing"
            >
              Processing
            </Link>
          </>
        )}

        {canSeeMyDecisions && (
          <>
            <Link
              className={stage === "my-decisions" && decisionAction === "all" ? styles.tabActive : styles.tab}
              href="/approvals?stage=my-decisions"
            >
              My Decisions
            </Link>
            <Link
              className={stage === "my-decisions" && decisionAction === "approve" ? styles.tabActive : styles.tab}
              href="/approvals?stage=my-decisions&action=approve"
            >
              Approved by Me
            </Link>
            <Link
              className={stage === "my-decisions" && decisionAction === "return" ? styles.tabActive : styles.tab}
              href="/approvals?stage=my-decisions&action=return"
            >
              Returned by Me
            </Link>
            <Link
              className={stage === "my-decisions" && decisionAction === "reject" ? styles.tabActive : styles.tab}
              href="/approvals?stage=my-decisions&action=reject"
            >
              Rejected by Me
            </Link>
          </>
        )}
      </div>

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
                  <td>
                    {stage === "my-decisions" && r.myDecision ? (
                      <span>{r.myDecision === "approve" ? "Approved by Me" : r.myDecision === "return" ? "Returned by Me" : "Rejected by Me"}</span>
                    ) : <Badge status={r.status} />}
                  </td>
                  <td>{formatDate(r.myDecisionAt || r.updatedAt || r.submittedAt)}</td>
                  <td><Link href={stage === "my-decisions" || stage === "awaiting-vc" || stage === "processing" ? `/requisitions/${r._id}` : `/approvals/${r._id}`} className={styles.reviewLink}>{stage === "my-decisions" ? "View" : stage === "processing" ? "Open" : stage === "awaiting-vc" ? "View" : "Review"}</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
