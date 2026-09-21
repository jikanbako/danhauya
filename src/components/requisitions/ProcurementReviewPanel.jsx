"use client";

import { useEffect, useMemo, useState } from "react";
import axios from "axios";
import toast from "react-hot-toast";
import Button from "@/components/ui/Button";
import { formatNaira } from "@/utils/formatNaira";
import { ROLES } from "@/constants/roles";
import { PROCUREMENT_MARKET_SURVEY_POSITIONS } from "@/constants/procurement";
import { useAuthStore } from "@/store/authStore";
import styles from "./ProcurementReviewPanel.module.css";

export default function ProcurementReviewPanel({ requisition, onUpdated }) {
  const user = useAuthStore((s) => s.user);
  const currentStep = requisition?.approvalChain?.[requisition.currentStepIndex];
  const isOfficerReviewStage =
    user?.role === ROLES.PROCUREMENT &&
    PROCUREMENT_MARKET_SURVEY_POSITIONS.includes(user?.procurementPosition) &&
    currentStep?.role === ROLES.PROCUREMENT &&
    currentStep?.type === "procurement_review" &&
    requisition?.procurementStatus !== "director_review" &&
    String(currentStep?.approver?._id || currentStep?.approver) === String(user?.id);

  const isDirectorReviewStage =
    user?.role === ROLES.PROCUREMENT &&
    user?.procurementPosition === "director" &&
    currentStep?.role === ROLES.PROCUREMENT &&
    currentStep?.type === "procurement_review" &&
    requisition?.procurementStatus === "director_review" &&
    String(currentStep?.approver?._id || currentStep?.approver) === String(user?.id);

  const isReviewStage = isOfficerReviewStage || isDirectorReviewStage;

  const [items, setItems] = useState([]);
  const [notes, setNotes] = useState(requisition?.procurementNotes || "");
  const [comment, setComment] = useState("");
  const [saving, setSaving] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!requisition) return;
    setItems(
      (requisition.items || []).map((item) => ({
        procurementUnitCost:
          item.procurementUnitCost ?? item.unitCost ?? 0,
        procurementNote: item.procurementNote || "",
      }))
    );
    setNotes(requisition.procurementNotes || "");
  }, [requisition]);

  const total = useMemo(
    () =>
      (requisition?.items || []).reduce(
        (sum, item, index) =>
          sum + Number(item.quantity || 0) * Number(items[index]?.procurementUnitCost || 0),
        0
      ),
    [requisition?.items, items]
  );

  if (!isReviewStage) return null;

  function updateItem(index, field, value) {
    setItems((current) =>
      current.map((item, i) => (i === index ? { ...item, [field]: value } : item))
    );
  }

  async function saveReview() {
    setSaving(true);
    try {
      const { data } = await axios.patch(`/api/requisitions/${requisition._id}/procurement-review`, {
        items: items.map((item) => ({
          procurementUnitCost: Number(item.procurementUnitCost),
          procurementNote: item.procurementNote,
        })),
        notes,
      });
      toast.success("Market-survey prices saved.");
      onUpdated?.(data.requisition);
    } catch (err) {
      toast.error(err.response?.data?.message || "Failed to save Procurement review.");
    } finally {
      setSaving(false);
    }
  }

  async function submitToNextStage() {
    if (isOfficerReviewStage && items.some((item) => item.procurementUnitCost === "" || Number(item.procurementUnitCost) < 0)) {
      toast.error("Enter a valid market-survey cost for every item.");
      return;
    }

    setSubmitting(true);
    try {
      if (isOfficerReviewStage) {
        await axios.patch(`/api/requisitions/${requisition._id}/procurement-review`, {
          items: items.map((item) => ({
            procurementUnitCost: Number(item.procurementUnitCost),
            procurementNote: item.procurementNote,
          })),
          notes,
        });
      }

      const { data } = await axios.post(`/api/requisitions/${requisition._id}/procurement-review`, {
        comment,
      });

      toast.success(
        isDirectorReviewStage
          ? "Market survey approved and sent to the VC."
          : "Market survey submitted to the Procurement Director."
      );
      onUpdated?.(data.requisition);
    } catch (err) {
      toast.error(err.response?.data?.message || "Failed to submit to VC.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className={styles.panel}>
      <div className={styles.header}>
        <div>
          <h3>{isDirectorReviewStage ? "Procurement Director Review" : "Procurement Market Survey"}</h3>
          <p>
            {isDirectorReviewStage
              ? "Review the completed market survey and BOQ prepared by the assigned Procurement officer before approving it for VC review."
              : "Review the requested prices against current market prices. Update the market unit cost and provide a reason for each item before submitting the completed survey to the Procurement Director."}
          </p>
        </div>
        <Button
          type="button"
          variant="secondary"
          onClick={() => window.open(`/api/requisitions/${requisition._id}/pdf?type=boq`, "_blank")}
        >
          <i className="bi bi-file-earmark-pdf" /> Generate BOQ
        </Button>
      </div>

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>#</th>
              <th>Item</th>
              <th>Qty</th>
              <th>Requested Unit Cost</th>
              <th>Market Unit Cost</th>
              <th>Market Total</th>
              <th>Reason / Note</th>
            </tr>
          </thead>
          <tbody>
            {(requisition.items || []).map((item, index) => {
              const marketCost = Number(items[index]?.procurementUnitCost || 0);
              return (
                <tr key={`${item.name}-${index}`}>
                  <td>{index + 1}</td>
                  <td>{item.name}</td>
                  <td>{item.quantity}</td>
                  <td>{formatNaira(item.requestedUnitCost ?? item.unitCost)}</td>
                  <td>
                    {isDirectorReviewStage ? (
                      formatNaira(items[index]?.procurementUnitCost)
                    ) : (
                      <input
                        className={styles.input}
                        type="number"
                        min="0"
                        step="0.01"
                        value={items[index]?.procurementUnitCost ?? ""}
                        onChange={(e) => updateItem(index, "procurementUnitCost", e.target.value)}
                      />
                    )}
                  </td>
                  <td>{formatNaira(Number(item.quantity || 0) * marketCost)}</td>
                  <td>
                    {isDirectorReviewStage ? (
                      item.procurementNote || "—"
                    ) : (
                      <input
                        className={styles.input}
                        type="text"
                        placeholder="Reason for price"
                        value={items[index]?.procurementNote || ""}
                        onChange={(e) => updateItem(index, "procurementNote", e.target.value)}
                      />
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <th colSpan="5" className={styles.totalLabel}>Revised Market-Survey Total</th>
              <th className={styles.total}>{formatNaira(total)}</th>
              <th />
            </tr>
          </tfoot>
        </table>
      </div>

      <label className={styles.label}>
        Procurement Market Survey Notes
        <textarea
          className={styles.textarea}
          rows={3}
          value={notes}
          readOnly={isDirectorReviewStage}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Summarise quotations, market checks, supplier comparisons, or other pricing considerations."
        />
      </label>

      <label className={styles.label}>
        {isDirectorReviewStage ? "Director Comment to VC (optional)" : "Comment to Procurement Director (optional)"}
        <textarea
          className={styles.textarea}
          rows={2}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="Message that will accompany the submission to the VC."
        />
      </label>

      <div className={styles.actions}>
        {isOfficerReviewStage && (
          <Button type="button" variant="secondary" onClick={saveReview} loading={saving}>
            <i className="bi bi-save" /> Save Market Survey
          </Button>
        )}
        <Button type="button" onClick={submitToNextStage} loading={submitting}>
          <i className="bi bi-send" /> {isDirectorReviewStage ? "Approve & Send to VC" : "Submit to Director"}
        </Button>
      </div>
    </section>
  );
}
