import {z} from 'zod';
/** Envelope metadata is produced by authenticated ingestion, never parsed from
 * message text/richMessage. Poll timestamps are hints, not live delivery proof. */
const instant=z.string().datetime({offset:true});
export const producerEvidence=z.object({captureKind:z.enum(['live_create','live_edit','live_delete']),capturedAt:instant}).strict();
const origin=z.object({classification:z.enum(['live_native','historical_snapshot','unknown']),basis:z.string(),firstObservedAt:instant,transport:z.string(),providerEventId:z.string().nullable(),clockUncertain:z.boolean()}).strict();
export const originEnvelope=z.object({version:z.literal(1),cutover:z.object({createdAt:instant.nullable(),basis:z.enum(['subscription_created','legacy_unknown']),clockUncertain:z.literal(true)}).strict(),sourceOrigin:origin,observation:z.object({transport:z.string(),phase:z.string(),providerEventId:z.string().nullable(),capturedAt:instant.nullable(),gap:z.boolean(),providerWindowComplete:z.boolean().nullable()}).strict(),activity:z.object({classification:z.enum(['live_create','live_edit','live_delete','historical_import','poll_candidate','observed_change','media_update','origin_confirmed','unknown']),basis:z.string(),triage:z.enum(['fresh','historical','review'])}).strict()}).strict();
export function unknownOrigin(at){return {classification:'unknown',basis:'legacy_or_missing_evidence',firstObservedAt:at,transport:'unknown',providerEventId:null,clockUncertain:true};}
export function cutover(s){return {createdAt:s.createdAt??null,basis:s.createdAt?'subscription_created':'legacy_unknown',clockUncertain:true};}
/** Preserve original historical affiliation. Only an authenticated live-create
 * callback can upgrade unknown discovery, with a separate durable evidence event. */
export function classify(s,m,oldOrigin,known,evidence,now){
 const p=producerEvidence.safeParse(evidence?.producer),created=Date.parse(s.createdAt),captured=p.success?Date.parse(p.data.capturedAt):NaN;
 const native=evidence?.transport==='telegram_native'||evidence?.transport==='gowa_webhook';
 const active=Date.parse(s.activeSince??s.createdAt),live=native&&p.success&&Number.isFinite(created)&&captured>=created&&captured>=active&&captured<=now+5000&&s.enabled;
 const first=oldOrigin??{...unknownOrigin(new Date(now).toISOString()),transport:evidence?.transport??'unknown',providerEventId:evidence?.providerEventId??null};
 let sourceOrigin=first,classification='unknown',basis='unverified_observation',triage='review';
 if(live){classification=p.data.captureKind;basis='authenticated_producer_live_callback_after_cutover';triage='fresh';if(!oldOrigin||oldOrigin.classification==='unknown'&&classification==='live_create')sourceOrigin={...first,classification:classification==='live_create'?'live_native':'unknown',transport:evidence.transport,providerEventId:evidence.providerEventId??null,basis:classification==='live_create'?basis:'creation_not_observed',clockUncertain:true};}
 if(live&&oldOrigin?.classification==='historical_snapshot'&&classification==='live_create'){classification='historical_import';basis='known_historical_source_native_redelivery';triage='historical';}
 else if(!live&&evidence?.transport==='history_poll'){
  if(known){classification='observed_change';basis='content_changed_since_durable_observation';triage='fresh';}
  else if(Number.isFinite(created)&&Date.parse(m.at)<created){classification='historical_import';basis='provider_history_before_cutover_clock_unverified';triage='historical';sourceOrigin={...first,classification:'historical_snapshot',basis};}
  else{classification='poll_candidate';basis='history_discovery_without_live_callback';}
 }
 if(known&&!oldOrigin&&classification==='observed_change')sourceOrigin=unknownOrigin(new Date(now).toISOString());
 return {version:1,cutover:cutover(s),sourceOrigin,observation:{transport:evidence?.transport??'unknown',phase:evidence?.phase??'unspecified',providerEventId:evidence?.providerEventId??null,capturedAt:p.success?p.data.capturedAt:null,gap:!!s.coverage?.gap,providerWindowComplete:evidence?.providerWindowComplete??null},activity:{classification,basis,triage}};
}
/** Legacy immutable rows gain conservative read-time defaults. Malformed
 * persisted metadata is not authority and cannot become confirmed live. */
export function readOrigin(e){const parsed=originEnvelope.safeParse(e.ingestion);if(parsed.success)return parsed.data;const at=e.receivedAt??e.observedAt;return {version:1,cutover:{createdAt:null,basis:'legacy_unknown',clockUncertain:true},sourceOrigin:unknownOrigin(at),observation:{transport:'unknown',phase:'legacy',providerEventId:null,capturedAt:null,gap:false,providerWindowComplete:null},activity:{classification:'unknown',basis:e.ingestion?'malformed_metadata':'legacy_metadata_absent',triage:'review'}};}
