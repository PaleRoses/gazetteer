import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { demoShipments } from '../../core/demo';
import { ports } from '../../core/ports';
import { positionAlong, progressAt, voyageRoute } from '../../core/routes';
import { defaultAlertPreferences, type FleetAlert, type Operations, type VesselInput } from '../../core/operations';
import type { Shipment } from '../../core/types';
import type { AssessedShipment } from '../assessment/apply';

export class OperationsError extends Error {}
type Row = { body: string };
type Baseline = { eta: string; status?: string; stale: boolean; stopped: boolean };
const hours = (later: string, earlier: string) => (Date.parse(later) - Date.parse(earlier)) / 3_600_000;

/** Workspace fleet membership and alert receipts survive both browser and actor restarts. */
export function createOperations(path: string, scenarioNow: Date = new Date()) {
  const db = new Database(path, { create: true });
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS fleet_workspaces (id TEXT PRIMARY KEY, preferences TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS fleet (workspace TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, removed INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(workspace,id));
    CREATE TABLE IF NOT EXISTS alert_baselines (workspace TEXT NOT NULL, ship TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(workspace,ship));
    CREATE TABLE IF NOT EXISTS alerts (workspace TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(workspace,id));`);
  const ensure = db.transaction((workspace: string) => {
    if (db.query('SELECT id FROM fleet_workspaces WHERE id=?').get(workspace)) return;
    db.query('INSERT INTO fleet_workspaces VALUES (?,?)').run(workspace, JSON.stringify(defaultAlertPreferences));
    for (const ship of demoShipments(scenarioNow)) db.query('INSERT INTO fleet(workspace,id,body) VALUES (?,?,?)').run(workspace, ship.id, JSON.stringify(ship));
  });
  const fleet = (workspace: string): Shipment[] => {
    ensure(workspace);
    return (db.query('SELECT body FROM fleet WHERE workspace=? AND removed=0 ORDER BY rowid').all(workspace) as Row[]).map(row => JSON.parse(row.body));
  };
  const preferences = (workspace: string): Operations['preferences'] => {
    ensure(workspace);
    return JSON.parse((db.query('SELECT preferences AS body FROM fleet_workspaces WHERE id=?').get(workspace) as Row).body);
  };
  const read = (workspace: string): Operations => ({ preferences: preferences(workspace), alerts: (db.query('SELECT body FROM alerts WHERE workspace=? ORDER BY rowid DESC LIMIT 250').all(workspace) as Row[]).map(row => JSON.parse(row.body)) });
  const save = db.transaction((workspace: string, input: VesselInput, author: string, current?: Shipment, now = new Date().toISOString()): Shipment => {
    const ships = fleet(workspace);
    if (input.id && !ships.some(s => s.id === input.id)) throw new OperationsError('Vessel not found in this fleet.');
    if (ships.some(s => s.id !== input.id && ((input.identity.imo && s.identity?.imo === input.identity.imo) || (input.identity.mmsi && s.identity?.mmsi === input.identity.mmsi)))) throw new OperationsError('That IMO or MMSI is already in your fleet.');
    const old = current ?? ships.find(s => s.id === input.id);
    const route = voyageRoute(input);
    if (!route) throw new OperationsError('This port combination is not available.');
    const id = input.id ?? `vessel-${randomUUID()}`;
    const statusSince = old?.voyage?.status === input.status ? old.voyage.statusSince : now;
    const ship: Shipment = {
      id, agent: old?.agent ?? `Navigator ${id.slice(-6)}`, vessel: input.vessel, identity: input.identity, reference: old?.reference ?? `GZ-${id.slice(-6).toUpperCase()}`,
      cargo: old?.cargo ?? 'Not specified', containers: old?.containers ?? 0,
      origin: input.origin, destination: input.destination, via: input.via, route,
      coordinates: positionAlong(route, input.status === 'planned' ? 0 : input.status === 'arrived' ? 1 : progressAt(input.departure, input.eta, Date.parse(now))) ?? ports.find(p => p.id === input.origin)!.coordinates,
      baselineEta: input.eta, eta: input.eta, risk: 'on-track', delayHours: 0,
      change: 'Operator-entered voyage plan. Arrival estimate has not been independently verified.', action: null,
      voyage: { departure: input.departure, eta: input.eta, status: input.status, statusSince, updatedAt: now, updatedBy: author, source: 'operator' },
      milestones: [
        { label: input.status === 'planned' ? 'Planned departure' : 'Reported departure', at: input.departure, status: input.status === 'planned' ? 'upcoming' : 'complete' },
        { label: input.status === 'arrived' ? 'Reported arrival' : 'Expected arrival', at: input.status === 'arrived' ? statusSince : input.eta, status: input.status === 'arrived' ? 'complete' : 'upcoming' },
      ], evidence: [], appliedDisruptions: old?.appliedDisruptions ?? [], assessments: [],
    };
    db.query('INSERT INTO fleet(workspace,id,body) VALUES (?,?,?) ON CONFLICT(workspace,id) DO UPDATE SET body=excluded.body').run(workspace, id, JSON.stringify(ship));
    return ship;
  });
  const remove = (workspace: string, id: string) => {
    if (!fleet(workspace).some(s => s.id === id)) throw new OperationsError('Vessel not found in this fleet.');
    db.query('UPDATE fleet SET removed=1 WHERE workspace=? AND id=?').run(workspace, id);
  };
  const observe = db.transaction((workspace: string, ships: readonly AssessedShipment[], now = new Date().toISOString()): void => {
    const thresholds = preferences(workspace);
    for (const ship of ships) {
      const row = db.query('SELECT body FROM alert_baselines WHERE workspace=? AND ship=?').get(workspace, ship.id) as Row | null;
      const previous: Baseline | undefined = row ? JSON.parse(row.body) : undefined;
      const source = ship.telemetry?.provenance ?? 'simulation';
      const stale = !!ship.telemetry && hours(now, ship.telemetry.observedAt) >= thresholds.staleHours;
      const stopped = ship.voyage?.status === 'stopped' && hours(now, ship.voyage.statusSince) >= thresholds.stopHours;
      let eta = previous?.eta ?? ship.eta;
      const add = (kind: FleetAlert['kind'], title: string, detail: string, from: FleetAlert['source']) => {
        const alert: FleetAlert = { id: randomUUID(), shipmentId: ship.id, vessel: ship.vessel, kind, title, detail, source: from, createdAt: now, acknowledgedAt: null };
        db.query('INSERT INTO alerts VALUES (?,?,?)').run(workspace, alert.id, JSON.stringify(alert));
      };
      if (previous && Math.abs(hours(ship.eta, previous.eta)) >= thresholds.etaHours) {
        const delta = hours(ship.eta, previous.eta);
        add('eta', `ETA ${delta > 0 ? 'slipped' : 'improved'} by ${Math.abs(delta).toFixed(1)}h`, `Previous: ${previous.eta}. Current: ${ship.eta}. Threshold: ${thresholds.etaHours}h.`, ship.voyage?.eta === ship.eta ? 'operator' : source);
        eta = ship.eta;
      }
      if (previous && previous.status !== ship.voyage?.status) {
        if (ship.voyage?.status === 'underway' && previous.status !== 'stopped') add('departure', 'Departure reported', `Operator reported departure from ${ship.origin} at ${ship.voyage.departure}.`, 'operator');
        if (ship.voyage?.status === 'arrived') add('arrival', 'Arrival reported', `Operator reported arrival at ${ship.destination}.`, 'operator');
      }
      if (stopped && !previous?.stopped) add('stop', 'Prolonged stop reported', `Operator marked stopped at ${ship.voyage!.statusSince}; the ${thresholds.stopHours}h threshold has elapsed.`, 'operator');
      if (stale && !previous?.stale) add('stale', 'Position report is stale', `Last position: ${ship.telemetry!.observedAt}. Threshold: ${thresholds.staleHours}h.`, source);
      db.query('INSERT INTO alert_baselines VALUES (?,?,?) ON CONFLICT(workspace,ship) DO UPDATE SET body=excluded.body').run(workspace, ship.id, JSON.stringify({ eta, status: ship.voyage?.status, stale, stopped } satisfies Baseline));
    }
  });
  return {
    fleet, save, remove, observe, read,
    setPreferences(workspace: string, value: Operations['preferences']) { ensure(workspace); db.query('UPDATE fleet_workspaces SET preferences=? WHERE id=?').run(JSON.stringify(value), workspace); },
    acknowledge(workspace: string, id: string) {
      const row = db.query('SELECT body FROM alerts WHERE workspace=? AND id=?').get(workspace, id) as Row | null;
      if (!row) throw new OperationsError('Alert not found in this workspace.');
      const alert: FleetAlert = JSON.parse(row.body);
      if (!alert.acknowledgedAt) db.query('UPDATE alerts SET body=? WHERE workspace=? AND id=?').run(JSON.stringify({ ...alert, acknowledgedAt: new Date().toISOString() }), workspace, id);
    },
    close() { db.close(); },
  };
}
