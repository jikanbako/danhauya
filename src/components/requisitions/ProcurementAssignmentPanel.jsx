"use client";

import { useEffect, useState } from "react";
import axios from "axios";
import toast from "react-hot-toast";
import Button from "@/components/ui/Button";
import { PROCUREMENT_ASSIGNMENT_POSITIONS } from "@/constants/procurement";
import { useAuthStore } from "@/store/authStore";
import { ROLES } from "@/constants/roles";
import styles from "./ProcurementAssignmentPanel.module.css";

export default function ProcurementAssignmentPanel({ requisition, onUpdated }) {
  const user = useAuthStore((state) => state.user);
  const [staff, setStaff] = useState([]);
  const [selected, setSelected] = useState("");
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(true);
  const [assigning, setAssigning] = useState(false);

  const currentStep = requisition?.approvalChain?.[requisition.currentStepIndex];
  const isIntake =
    user?.role === ROLES.PROCUREMENT &&
    currentStep?.role === ROLES.PROCUREMENT &&
    currentStep?.type === "procurement_review" &&
    requisition?.procurementStatus !== "director_review" &&
    String(currentStep?.approver?._id || currentStep?.approver) === String(user?.id) &&
    PROCUREMENT_ASSIGNMENT_POSITIONS.includes(user?.procurementPosition);

  useEffect(() => {
    if (!isIntake) {
      setLoading(false);
      return;
    }

    axios
      .get("/api/procurement/staff")
      .then(({ data }) => setStaff(data.staff || []))
      .catch((err) => toast.error(err.response?.data?.message || "Failed to load Procurement staff."))
      .finally(() => setLoading(false));
  }, [isIntake]);

  if (!isIntake) return null;

  async function assign() {
    if (!selected) {
      toast.error("Select a Procurement staff member.");
      return;
    }

    setAssigning(true);
    try {
      const { data } = await axios.post(
        `/api/requisitions/${requisition._id}/procurement-assign`,
        { procurementOfficerId: selected, note }
      );
      toast.success("Market-survey work assigned successfully.");
      onUpdated?.(data.requisition);
    } catch (err) {
      toast.error(err.response?.data?.message || "Failed to assign Procurement officer.");
    } finally {
      setAssigning(false);
    }
  }

  return (
    <section className={styles.panel}>
      <div className={styles.header}>
        <div>
          <h3>Procurement Intake & Assignment</h3>
          <p>
            You are receiving this requisition as Procurement management. Assign the market-survey
            work to the appropriate Principal/Senior Procurement Officer or Procurement Officer I/II.
          </p>
        </div>
      </div>

      <div className={styles.meta}>
        <div>
          <strong>Received by</strong>
          <span>{user.fullName}</span>
        </div>
        <div>
          <strong>Requisition</strong>
          <span>{requisition.requisitionNumber || requisition._id}</span>
        </div>
      </div>

      <label className={styles.label}>
        Assign market-survey officer
        <select
          className={styles.select}
          value={selected}
          onChange={(event) => setSelected(event.target.value)}
          disabled={loading || assigning}
        >
          <option value="">
            {loading ? "Loading Procurement staff…" : "Select staff member"}
          </option>
          {staff.map((member) => (
            <option key={member._id} value={member._id}>
              {member.fullName} — {member.positionLabel}
            </option>
          ))}
        </select>
      </label>

      <label className={styles.label}>
        Assignment note (optional)
        <textarea
          className={styles.textarea}
          rows={2}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="e.g. Please conduct the market survey and prepare the BOQ."
        />
      </label>

      <div className={styles.actions}>
        <Button type="button" onClick={assign} loading={assigning} disabled={loading}>
          <i className="bi bi-person-check" /> Assign Market Survey
        </Button>
      </div>
    </section>
  );
}
