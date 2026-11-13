import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,chmodSync} from 'node:fs';
import {dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {HubError,key} from './contracts.mjs';

/** Private metadata journal. It stores message hashes and IDs, never message/profile bodies. */
export class Store {
  constructor(filename){
    if(filename!==':memory:'){mkdirSync(dirname(filename),{recursive:true,mode:0o700});}
    this.db=new DatabaseSync(filename);
    if(filename!==':memory:')chmodSync(filename,0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS messages (key TEXT PRIMARY KEY,digest TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (sequence INTEGER PRIMARY KEY AUTOINCREMENT,connection TEXT NOT NULL,conversation TEXT NOT NULL,message TEXT NOT NULL,kind TEXT NOT NULL,at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS send_evidence(key TEXT PRIMARY KEY,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS deliveries (key TEXT PRIMARY KEY,digest TEXT NOT NULL,status TEXT NOT NULL,message TEXT);
    `);
  }
  observe(connectionId,items){
    this.db.exec('BEGIN IMMEDIATE');
    try{
      for(const item of items){
        const identity=key(connectionId,item.conversationId,item.id), digest=hash(item);
        const prior=this.db.prepare('SELECT digest FROM messages WHERE key=?').get(identity);
        if(prior?.digest===digest)continue;
        this.db.prepare('INSERT INTO messages VALUES(?,?) ON CONFLICT(key) DO UPDATE SET digest=excluded.digest').run(identity,digest);
        this.db.prepare('INSERT INTO events(connection,conversation,message,kind,at) VALUES(?,?,?,?,?)').run(connectionId,item.conversationId,item.id,item.deletedAt?'deleted':prior?'updated':'created',new Date().toISOString());
      }
      this.db.exec('COMMIT');
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  /** Query only authorized identities before limiting; forbidden event counts never leak. */
  events(after,limit,grants){
    const clauses=[],args=[];
    for(const [connection,scope] of Object.entries(grants)){
      if(!scope.read)continue;
      if(scope.conversations==='*'){clauses.push('(connection=?)');args.push(connection);}
      else if(scope.conversations.length){clauses.push(`(connection=? AND conversation IN (${scope.conversations.map(()=>'?').join(',')}))`);args.push(connection,...scope.conversations);}
    }
    if(!clauses.length)return [];
    return this.db.prepare(`SELECT sequence,connection AS connectionId,conversation AS conversationId,message AS messageId,kind,at FROM events WHERE sequence>? AND (${clauses.join(' OR ')}) ORDER BY sequence LIMIT ?`).all(after,...args,limit);
  }
  /** Persist unknown BEFORE network I/O: crashes and concurrent retries cannot duplicate a write. */
  beginSend(scope,input){
    const identity=key(scope,input.connectionId,input.requestId),digest=hash(input);
    const fresh=this.db.prepare("INSERT OR IGNORE INTO deliveries VALUES(?,?,'unknown',NULL)").run(identity,digest).changes;
    if(fresh)this.saveEvidence(identity,{startedAt:new Date().toISOString()});
    const row=this.db.prepare('SELECT * FROM deliveries WHERE key=?').get(identity);
    if(row.digest!==digest)throw new HubError('idempotency_conflict');
    return identity;
  }
  evidence(identity){const r=this.db.prepare('SELECT body FROM send_evidence WHERE key=?').get(identity);return r?JSON.parse(r.body):null;}
  /** Checkpoints hold IDs/times only, before or immediately after transport, never message bodies. */
  saveEvidence(identity,value){const body={...this.evidence(identity),...value};this.db.prepare('INSERT INTO send_evidence VALUES(?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body').run(identity,JSON.stringify(body));}
  delivery(identity){const r=this.db.prepare('SELECT status,message FROM deliveries WHERE key=?').get(identity);return r?{status:r.status,messageId:r.message}:null;}
  finish(identity,result){this.db.prepare('UPDATE deliveries SET status=?,message=? WHERE key=?').run(result.status,result.messageId??null,identity);return result;}
  hasSend(scope,input){return !!this.db.prepare('SELECT 1 FROM deliveries WHERE key=?').get(key(scope,input.connectionId,input.requestId));}
  close(){this.db.close();}
}
export function hash(value){return createHash('sha256').update(JSON.stringify(value)).digest('hex');}
