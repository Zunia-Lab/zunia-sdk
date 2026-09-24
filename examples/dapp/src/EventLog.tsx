import type { EventLogApi } from "./useEventLog";

export function EventLog({ log }: { log: EventLogApi }) {
  return (
    <section className="card">
      <div className="card-title">
        <h2>Events</h2>
        <button type="button" className="link" onClick={log.clear} disabled={log.entries.length === 0}>
          Clear
        </button>
      </div>
      <p className="muted">Lock the wallet, switch accounts or revoke this site in Zunia: each change arrives here live.</p>
      <ol className="log" data-testid="event-log">
        {log.entries.map((entry) => (
          <li key={entry.id} data-kind={entry.kind}>
            <time>{entry.time}</time>
            <strong>{entry.kind}</strong>
            <span>{entry.detail}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
