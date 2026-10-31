import { createSignal, For, Show } from 'solid-js';
import { ArrowRight, FlaskConical } from 'lucide-solid';
import { ports, type PortId } from '../core/ports';
import { disruptionScenarios, simulateDisruption, type SimulationInput, type SimulationResult } from '../core/simulation';
import type { Dashboard } from '../core/types';
import { date, portName, RiskBadge, time } from './presentation';
import './simulation.css';

export function SimulationPage(props: Readonly<{ dashboard: Dashboard | null; result: SimulationResult | null; onResult: (result: SimulationResult | null) => void }>) {
  const [scenario, setScenario] = createSignal<SimulationInput['scenario']>(props.result?.input.scenario ?? 'congestion');
  const [portId, setPortId] = createSignal<PortId>(props.result?.input.portId ?? 'singapore');
  const [hours, setHours] = createSignal(props.result?.input.delayHours ?? 12);
  const selected = () => disruptionScenarios.find(item => item.id === scenario())!;
  const changed = () => props.result && (props.result.input.scenario !== scenario() || props.result.input.portId !== portId() || props.result.input.delayHours !== hours());
  function run(event: SubmitEvent) {
    event.preventDefault();
    const dashboard = props.dashboard;
    if (dashboard) props.onResult(simulateDisruption(dashboard.shipments, { scenario: scenario(), portId: portId(), delayHours: hours() }, dashboard.updatedAt));
  }
  return <main class="simulation-page"><div class="simulation-content">
    <header><span class="section-kicker">WHAT-IF PLANNING</span><h1>Simulate a disruption</h1><p>Test a port disruption against your fleet’s current arrival estimates.</p><span class="scenario-isolation"><FlaskConical size={14} />Private preview · main map, fleet and alerts stay unchanged</span></header>
    <form class="scenario-controls" onSubmit={run}>
      <label>Disruption<select value={scenario()} onChange={event => { const next = disruptionScenarios.find(item => item.id === event.currentTarget.value)!; setScenario(next.id); setHours(next.hours); }}><For each={disruptionScenarios}>{item => <option value={item.id}>{item.label}</option>}</For></select></label>
      <label>Destination port<select value={portId()} onChange={event => setPortId(event.currentTarget.value as PortId)}><For each={ports}>{port => <option value={port.id}>{port.name}</option>}</For></select></label>
      <label>Added delay (hours)<input type="number" min="1" max="168" step="1" required value={hours()} onInput={event => setHours(event.currentTarget.valueAsNumber)} /></label>
      <button class="primary" disabled={!props.dashboard}><FlaskConical size={15} />Run simulation</button>
      <p>{selected().description} Apply the selected delay once to each future arrival at this destination. Transit calls, rerouting and knock-on congestion are outside this estimate.</p>
    </form>
    <Show when={changed()}><p class="scenario-changed" role="status">Settings changed. Run simulation to update the results below.</p></Show>
    <Show when={props.result} fallback={<section class="scenario-empty"><FlaskConical size={24} /><h2>Explore the impact before making a call</h2><p>Select a disruption and port, then run a scenario to compare arrival times.</p></section>}>{result => <section class="scenario-results" aria-label="Simulation results" aria-live="polite">
      <div class="scenario-result-heading"><div><span class="section-kicker">SCENARIO RESULTS</span><h2>{disruptionScenarios.find(item => item.id === result().input.scenario)?.label} at {portName(ports, result().input.portId)}</h2><p>+{result().input.delayHours}h assumed delay · {result().vessels.length} of {result().fleetSize} vessels affected</p></div><button class="text-button" onClick={() => props.onResult(null)}>Clear results</button></div>
      <p class="scenario-timestamp">Fleet snapshot: {date(result().sourceUpdatedAt)} · {time(result().sourceUpdatedAt)} UTC. Each run starts from the current fleet; scenario delays never accumulate.</p>
      <Show when={result().vessels.length > 0} fallback={<p class="scenario-no-impact">No future arrivals at this destination in the captured fleet. Choose a port served by an upcoming voyage.</p>}>
        <div class="scenario-table-wrap"><table><thead><tr><th>Vessel / route</th><th>Current ETA</th><th>Scenario ETA</th><th>Scenario risk</th></tr></thead><tbody><For each={result().vessels}>{ship => <tr><td><strong>{ship.vessel}</strong><small>{portName(ports, ship.origin)} → {portName(ports, ship.destination)}</small></td><td>{date(ship.currentEta)}<small>{time(ship.currentEta)} UTC</small></td><td class="scenario-eta">{date(ship.scenarioEta)}<small>{time(ship.scenarioEta)} UTC · +{result().input.delayHours}h</small></td><td><RiskBadge risk={ship.risk} /></td></tr>}</For></tbody></table></div>
      </Show>
      <p class="scenario-method"><ArrowRight size={14} />Rule-based estimate using your delay assumption. Risk reflects total schedule delay: moderate below 24h, high at 24h or more; existing higher risk is retained.</p>
    </section>}</Show>
  </div></main>;
}
