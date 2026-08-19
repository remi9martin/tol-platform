import type { TimelineEventDTO } from "@tol/contracts";
import { formatDateTime, shortId } from "@/lib/format";

/** the spec: "Timeline: immutable domain events rendered for users." Merges the DealRoom's own events with its originating RFQ's (apps/api's dealsService.getTimeline) — this component just renders whatever it's handed, chronological order is already the API's contract. */
const EVENT_LABELS: Record<string, string> = {
  "rfq.sent": "RFQ sent",
  "rfq.acknowledged": "RFQ acknowledged",
  "rfq.declined": "Provider declined",
  "quote.submitted": "Quote submitted",
  "quote.withdrawn": "Quote withdrawn",
  "quote.selected": "Quote selected",
  "deal.opened": "Deal room opened",
  "deal.participant_added": "Participant added",
  "deal.condition_created": "Condition posted",
  "deal.condition_resolved": "Condition resolved",
  "deal.decision_recorded": "Decision recorded",
  "deal.stage_changed": "Stage changed",
  "deal.activated": "Deal activated",
  "deal.live": "Deal went live",
  "deal.archived": "Deal archived",
};

export function DealTimeline({ events }: { events: TimelineEventDTO[] }) {
  if (events.length === 0) {
    return <p className="text-sm text-ink-3">No timeline events yet.</p>;
  }

  return (
    <ol className="flex flex-col gap-0">
      {events.map((event, i) => (
        <li key={event.id} className="relative flex gap-3 pb-4 last:pb-0">
          <div className="flex flex-col items-center">
            <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-red" />
            {i < events.length - 1 && <span className="w-px flex-1 bg-edge-2" />}
          </div>
          <div className="min-w-0 pb-1">
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="text-sm text-ink">{EVENT_LABELS[event.eventType] ?? event.eventType}</span>
              <span className="mono-label">{formatDateTime(event.occurredAt)}</span>
            </div>
            <div className="mt-0.5 text-xs text-ink-3">
              {event.actorOrgId ? `by ${shortId(event.actorOrgId)}` : "system"}
              {event.actorRole ? ` · ${event.actorRole}` : ""}
              {" · "}
              {event.aggregateType === "rfq" ? "RFQ history" : "deal room"}
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}
