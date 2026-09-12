import fs from 'fs';
import path from 'path';
import { nanoid } from 'nanoid';
import { getFirestoreDb } from './firebaseAdmin';
import { FieldValue } from 'firebase-admin/firestore';
import { AdminSpeakingMaterial, AdminReadingMaterial, AdminListeningMaterial, AdminWritingMaterial, AdminMaterial, AdminStats, MaterialLifecycleStatus } from '../types/admin';
import { bundleStore } from './bundleStore';
import { parseMaterialForWrite, migrateStoredMaterial } from '../schemas/material';
import type { StoredGenerationReview } from '../schemas/material';
import { publishBlockers } from './publishGate';
import type { PublishBlocker, PublishGateContext } from './publishGate';
import type { QuestionIssue } from '../schemas/question';
import { describeQuestionIssue } from '../schemas/question';
import { ClientRequestError, InvalidIdentifierError } from '../http/errors';
import { materialRecordFingerprint } from './materialVersion';

const DATA_DIR = path.join(process.cwd(), 'data', 'admin_content');
const PRIVATE_UPLOADS_DIR = path.join(process.cwd(), 'data', 'private_uploads');
const PUBLIC_UPLOADS_DIR = path.join(process.cwd(), 'data', 'uploads');
const useFirestore = () => process.env.NODE_ENV === 'production' || process.env.STORAGE_BACKEND === 'gcs_firestore';
if (!fs.existsSync(PRIVATE_UPLOADS_DIR)) fs.mkdirSync(PRIVATE_UPLOADS_DIR, { recursive: true });
if (!useFirestore()) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(PUBLIC_UPLOADS_DIR)) fs.mkdirSync(PUBLIC_UPLOADS_DIR, { recursive: true });
}

type SectionType = 'speaking' | 'reading' | 'listening' | 'writing';
type MaterialStatusFilter='all'|'published'|'draft'|'archived';
const assertId = (v:string) => { if (!/^[A-Za-z0-9_.-]{1,160}$/.test(v)) throw new InvalidIdentifierError(); };

/**
 * A material that could not be made canonical. Carries the per-field reasons so
 * the route can tell the admin which question is wrong rather than "save
 * failed".
 */
export class MaterialValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Material failed validation: ${issues.join(' | ')}`);
    this.name = 'MaterialValidationError';
  }
}

/**
 * A write refused because the material is no longer the one its author opened.
 *
 * Materials are edited in place and published by a separate act, so two admins
 * — or an admin and a publish — can act on the same row at once. A write names
 * the revision (`updatedAt`) it was based on, and is refused if the row has moved
 * on: anything else would silently overwrite a change its author never saw.
 */
export class MaterialConflictError extends ClientRequestError {
  constructor(code: 'material_revision_required' | 'material_stale' | 'material_changed_during_publish') {
    super(
      code === 'material_revision_required' ? 428 : 409,
      code,
      code === 'material_revision_required'
        ? 'Saving an existing material needs the revision it was opened at (updatedAt). Reload it and save again.'
        : code === 'material_stale'
          ? 'This material has changed since it was opened. Reload it to see the current version, then make your edit again.'
          : 'This material changed while it was being published, so it was not published. Check it again.',
    );
    this.name = 'MaterialConflictError';
  }
}

/** A write the material's lifecycle state does not allow. */
export class MaterialStateError extends ClientRequestError {
  constructor(code: 'not_draft' | 'material_published') {
    super(
      409,
      code,
      code === 'not_draft'
        ? 'Only a draft can be reviewed. Unpublish it first.'
        : 'This material is published. Unpublish or archive it before deleting.',
    );
    this.name = 'MaterialStateError';
  }
}

/**
 * The revision a write stamps: now, and always later than the one it replaces.
 * Two writes inside one millisecond would otherwise share a revision, and an
 * editor still holding it would pass the stale-write check.
 */
function nextRevision(previous: unknown): string {
  const now = Date.now();
  const last = typeof previous === 'string' ? Date.parse(previous) : Number.NaN;
  return new Date(Number.isFinite(last) && last >= now ? last + 1 : now).toISOString();
}
const assertObject = (value:unknown,name:string,maxBytes=2_000_000) => { if(!value || typeof value!=='object' || Array.isArray(value)) throw new Error(`Invalid ${name}.`); const bytes=Buffer.byteLength(JSON.stringify(value),'utf8'); if(bytes>maxBytes) throw new Error(`${name} is too large.`); };
/**
 * Shape checks that must hold before the schema even runs: the row has to be an
 * object, small enough to store, and it must not claim a different section than
 * the one it is being written to.
 */
const assertMaterialEnvelope=(section:SectionType,value:unknown)=>{assertObject(value,'material');const v=value as Record<string,unknown>;if(v.id!=null)assertId(String(v.id));if(v.section!=null&&v.section!==section)throw new Error('Material section mismatch.');};

class AdminStore {
  private getFilePath(collection:string){return path.join(DATA_DIR,`${collection}.json`);}
  private readCollection<T>(collection:string):T[]{const filePath=this.getFilePath(collection);try{if(!fs.existsSync(filePath)){fs.writeFileSync(filePath,'[]','utf-8');return [];}const value=JSON.parse(fs.readFileSync(filePath,'utf-8'));return Array.isArray(value)?value as T[]:[];}catch{return [];}}
  private writeCollection<T>(collection:string,items:T[]):void{const filePath=this.getFilePath(collection),tmp=`${filePath}.tmp.${process.pid}.${Date.now()}.${nanoid(4)}`;fs.writeFileSync(tmp,JSON.stringify(items,null,2),'utf-8');fs.renameSync(tmp,filePath);}
  private async firestoreList<T>(section:string,statusFilter?:MaterialStatusFilter):Promise<T[]>{let q:any=getFirestoreDb().collection('admin_content').doc(section).collection('items');if(statusFilter&&statusFilter!=='all')q=q.where('status','==',statusFilter);const s=await q.get();return s.docs.map((d:any)=>d.data() as T);}
  /**
   * Published or draft materials in one section, with any legacy question
   * shapes migrated to canonical on the way out.
   *
   * Migration is read-only: the row on disk is untouched, so a question that
   * cannot be converted is reported by `reviewMaterials` rather than lost.
   */
  public async listMaterials(section:SectionType,statusFilter?:MaterialStatusFilter):Promise<AdminMaterial[]>{
    const rows=useFirestore()
      ?await this.firestoreList<Record<string,unknown>>(section,statusFilter)
      :this.readCollection<Record<string,unknown>>(section).filter(x=>!statusFilter||statusFilter==='all'||x.status===statusFilter);
    return rows.map(row=>migrateStoredMaterial(row).material as AdminMaterial);
  }

  /**
   * The same list, plus the questions in each material that could not be made
   * canonical. Nothing is invented to fill a gap: a material with entries here
   * needs a human before it is fit to sit.
   */
  public async reviewMaterials(section:SectionType,statusFilter?:MaterialStatusFilter):Promise<Array<{material:AdminMaterial;needsReview:QuestionIssue[]}>>{
    const rows=useFirestore()
      ?await this.firestoreList<Record<string,unknown>>(section,statusFilter)
      :this.readCollection<Record<string,unknown>>(section).filter(x=>!statusFilter||statusFilter==='all'||x.status===statusFilter);
    return rows.map(row=>{const r=migrateStoredMaterial(row);return{material:r.material as AdminMaterial,needsReview:r.needsReview};});
  }
  public async getMaterial(section:SectionType,id:string):Promise<AdminMaterial|null>{
    assertId(id);
    let row:unknown=null;
    if(useFirestore()){
      const snap=await getFirestoreDb().collection('admin_content').doc(section).collection('items').doc(id).get();
      row=snap.exists?snap.data()||null:null;
    }else{
      row=this.readCollection<Record<string,unknown>>(section).find(item=>item.id===id)||null;
    }
    return row?(migrateStoredMaterial(row).material as AdminMaterial):null;
  }
  /**
   * Writes a material, refusing anything that is not canonical.
   *
   * Validation runs on the *merged* record rather than on the incoming patch:
   * an update carrying half a material would otherwise pass its own check and
   * still leave an unusable row on disk. `parseMaterialForWrite` also converts
   * legacy question shapes, so this is the single point at which authored data
   * becomes canonical.
   *
   * For callers inside the server that create materials (Book → Test) or seed
   * fixtures. Saves through the admin API use `saveMaterialDetailed` and must
   * name the revision they were opened at.
   */
  public async saveMaterial(section:SectionType,materialData:unknown,author='Admin'):Promise<AdminMaterial>{
    return (await this.saveMaterialDetailed(section,materialData,author)).material;
  }

  /**
   * Writes a material, and says what the write did to its lifecycle.
   *
   * Learners read published rows directly, so a published material must never
   * hold content its publish gate has not passed (H4). Therefore:
   *
   *   - a save that changes a published material in any way — content,
   *     questions, classification, assets, provenance, anything but the revision
   *     stamp — writes it back as `draft`, in that same write. It reaches learners
   *     again only through `setMaterialStatus`, behind the gate, so there is no
   *     moment at which the new content is published;
   *   - a save identical to the stored record writes nothing and changes nothing;
   *   - `expectedUpdatedAt`, when given, must be the stored revision, and
   *     `requireRevision` makes it mandatory for an update.
   *
   * Every check happens inside the write — the synchronous read-modify-write of
   * the local store, a transaction on Firestore — so an edit, another admin's
   * edit and a publish cannot slip in between the check and the write.
   */
  public async saveMaterialDetailed(section:SectionType,materialData:unknown,author='Admin',options:{expectedUpdatedAt?:string;requireRevision?:boolean}={}):Promise<{material:AdminMaterial;unpublished:boolean;unchanged:boolean}>{
    assertId(section);
    assertMaterialEnvelope(section,materialData);
    const incoming=materialData as Record<string,unknown>;
    const newId=()=>`adm-${section.slice(0,3)}-${Date.now()}-${nanoid(5)}`;

    if(useFirestore()){
      const db=getFirestoreDb();
      const id=incoming.id?String(incoming.id):newId();
      assertId(id);
      const ref=db.collection('admin_content').doc(section).collection('items').doc(id);
      return db.runTransaction(async tx=>{
        const existing=await tx.get(ref);
        const previous=(existing.exists?existing.data():undefined)as Record<string,unknown>|undefined;
        const outcome=this.applySave(section,previous,incoming,id,author,options);
        if(!outcome.unchanged)tx.set(ref,outcome.material,{merge:true});
        return outcome;
      });
    }

    const items=this.readCollection<Record<string,unknown>>(section);
    const index=incoming.id?items.findIndex(x=>x.id===incoming.id):-1;
    const previous=index>=0?items[index]:undefined;
    const id=String(incoming.id||newId());
    assertId(id);
    const outcome=this.applySave(section,previous,incoming,id,author,options);
    if(outcome.unchanged)return outcome;
    if(index>=0)items[index]=outcome.material as unknown as Record<string,unknown>;
    else items.unshift(outcome.material as unknown as Record<string,unknown>);
    this.writeCollection(section,items);
    return outcome;
  }

  /**
   * What a save does to the stored row, decided before anything is written.
   * Throws on a missing or stale revision, or on content that is not canonical.
   */
  private applySave(section:SectionType,previous:Record<string,unknown>|undefined,incoming:Record<string,unknown>,id:string,author:string,options:{expectedUpdatedAt?:string;requireRevision?:boolean}):{material:AdminMaterial;unpublished:boolean;unchanged:boolean}{
    // A row written before revisions were stamped has nothing to compare against;
    // its first save stamps one.
    const storedRevision=typeof previous?.updatedAt==='string'?previous.updatedAt:undefined;
    if(previous&&storedRevision!==undefined){
      if(options.expectedUpdatedAt===undefined){
        if(options.requireRevision)throw new MaterialConflictError('material_revision_required');
      }else if(options.expectedUpdatedAt!==storedRevision){
        throw new MaterialConflictError('material_stale');
      }
    }
    const material=this.finalise(section,previous,incoming,id,author,nextRevision(storedRevision));
    if(previous?.status!=='published')return{material,unpublished:false,unchanged:false};
    const stored=migrateStoredMaterial(previous).material as AdminMaterial;
    if(materialRecordFingerprint(stored)===materialRecordFingerprint(material))return{material:stored,unpublished:false,unchanged:true};
    return{material:{...material,status:'draft'},unpublished:true,unchanged:false};
  }

  /**
   * Merges an update over what is stored, validates the result, and stamps the
   * bookkeeping fields.
   *
   * `status` keeps the historical default of `published` when the caller does
   * not say; phase 8 is where that becomes `draft` behind an explicit publish
   * action.
   */
  private finalise(section:SectionType,previous:Record<string,unknown>|undefined,incoming:Record<string,unknown>,id:string,author:string,now:string):AdminMaterial{
    const candidate:Record<string,unknown>={
      ...(previous||{}),
      ...incoming,
      id,
      section,
      // A save never publishes. `setMaterialStatus` is the only transition, and
      // a material starts out in the state that reaches nobody.
      status:previous?.status??'draft',
      author:incoming.author??previous?.author??author,
      createdAt:previous?.createdAt??now,
      updatedAt:now,
    };
    // An import record is evidence of where a material came from, not editable
    // content, so it is written once and then carried forward. The merge above
    // replaces `content` wholesale, so an ordinary edit through the material
    // editor — which knows nothing about importing — would otherwise erase the
    // provenance of an imported material the first time somebody fixed a typo in
    // it, and a crafted request could otherwise rewrite the record to claim the
    // parser had read an answer key it never saw.
    const previousContent=previous?.content as Record<string,unknown>|undefined;
    const nextContent=candidate.content as Record<string,unknown>|undefined;
    if(previousContent?.importRecord&&nextContent&&typeof nextContent==="object"&&!Array.isArray(nextContent)){
      candidate.content={...nextContent,importRecord:previousContent.importRecord};
    }
    // The generation record is evidence in the same sense, and more exposed: it
    // holds the validation verdict the publish gate trusts. A request that could
    // rewrite it could turn a needs-review question into a valid one by assertion.
    const contentNow=candidate.content as Record<string,unknown>|undefined;
    if(previousContent?.generationRecord&&contentNow&&typeof contentNow==="object"&&!Array.isArray(contentNow)){
      candidate.content={...contentNow,generationRecord:previousContent.generationRecord};
    }
    // Reviewer decisions are appended by `appendGenerationReview` alone, which
    // takes the reviewer from the session. A save carries the existing log
    // forward and discards whatever the request sent, so a confirmation can be
    // neither forged nor erased by editing the material.
    const contentForReviews=candidate.content as Record<string,unknown>|undefined;
    if(contentForReviews&&typeof contentForReviews==="object"&&!Array.isArray(contentForReviews)){
      const {generationReviews:_discarded,...rest}=contentForReviews;
      candidate.content=previousContent?.generationReviews?{...rest,generationReviews:previousContent.generationReviews}:rest;
    }
    const parsed=parseMaterialForWrite(section,candidate);
    if(!parsed.ok)throw new MaterialValidationError(parsed.issues);
    return parsed.material as unknown as AdminMaterial;
  }
  /**
   * Deletes a material, refusing a published one inside the write. The route
   * checks first, but a publish landing between that check and this delete would
   * otherwise remove a learner-visible material without withdrawing it.
   */
  public async deleteMaterial(section:SectionType,id:string):Promise<boolean>{
    assertId(id);
    if(useFirestore()){
      const db=getFirestoreDb();
      const ref=db.collection('admin_content').doc(section).collection('items').doc(id);
      return db.runTransaction(async tx=>{
        const snap=await tx.get(ref);
        if(!snap.exists)return false;
        if(snap.data()?.status==='published')throw new MaterialStateError('material_published');
        tx.delete(ref);
        return true;
      });
    }
    const items=this.readCollection<Record<string,unknown>>(section);
    const target=items.find(item=>item.id===id);
    if(!target)return false;
    if(target.status==='published')throw new MaterialStateError('material_published');
    this.writeCollection(section,items.filter(item=>item.id!==id));
    return true;
  }
  /**
   * Appends one reviewer decision to a generated material.
   *
   * The only write path for `generationReviews`. The whole material is validated
   * again, so a decision about a question the record does not know, or one the
   * machine did not flag, is refused here as well as at the route.
   *
   * Only a draft takes a decision, and that is checked inside the write. The
   * publish gate reads these decisions, so one landing on a published material —
   * a publish slipping in after the route's own check — could leave it published
   * with a question the gate would now refuse.
   */
  public async appendGenerationReview(section:SectionType,id:string,review:StoredGenerationReview):Promise<AdminMaterial>{
    assertId(id);
    const append=(row:Record<string,unknown>|undefined):AdminMaterial=>{
      if(!row)throw new Error('Material not found.');
      if(row.status!=='draft')throw new MaterialStateError('not_draft');
      const content=(row.content??{}) as Record<string,unknown>;
      const existing=Array.isArray(content.generationReviews)?content.generationReviews:[];
      const next={...row,content:{...content,generationReviews:[...existing,review]},updatedAt:nextRevision(row.updatedAt)};
      const parsed=parseMaterialForWrite(section,next);
      if(!parsed.ok)throw new MaterialValidationError(parsed.issues);
      return parsed.material as unknown as AdminMaterial;
    };
    if(useFirestore()){
      const db=getFirestoreDb();
      const ref=db.collection('admin_content').doc(section).collection('items').doc(id);
      return db.runTransaction(async tx=>{
        const snap=await tx.get(ref);
        const material=append(snap.exists?(snap.data() as Record<string,unknown>):undefined);
        tx.set(ref,material);
        return material;
      });
    }
    const items=this.readCollection<Record<string,unknown>>(section);
    const index=items.findIndex(item=>item.id===id);
    const material=append(index>=0?items[index]:undefined);
    items[index]=material as unknown as Record<string,unknown>;
    this.writeCollection(section,items);
    return material;
  }

  /**
   * One material, alongside the questions its stored row cannot make canonical.
   *
   * `getMaterial` migrates on read, so the unconvertible questions are gone from
   * what it returns. Anything deciding whether a material is fit to publish has
   * to see the row as it really is.
   */
  public async reviewMaterial(section:SectionType,id:string):Promise<{material:AdminMaterial;needsReview:QuestionIssue[]}|null>{
    assertId(id);
    let row:unknown=null;
    if(useFirestore()){
      const snap=await getFirestoreDb().collection('admin_content').doc(section).collection('items').doc(id).get();
      row=snap.exists?snap.data()||null:null;
    }else{
      row=this.readCollection<Record<string,unknown>>(section).find(item=>item.id===id)||null;
    }
    if(!row)return null;
    const result=migrateStoredMaterial(row);
    return {material:result.material as AdminMaterial,needsReview:result.needsReview};
  }

  /**
   * Moves a material between lifecycle states, and nothing else.
   *
   * Separated from `saveMaterial` because the two answer different questions:
   * a save asks whether the content is well formed, a publish asks whether it
   * is fit for a learner. While they were one act, anything that could be
   * written could be published — including a material whose answer key the
   * importer never found.
   *
   * The gate runs only on the way to `published`. Withdrawing or retiring a
   * material is always allowed: refusing to unpublish something broken would
   * be exactly backwards.
   */
  public async setMaterialStatus(section:SectionType,id:string,status:MaterialLifecycleStatus,context:PublishGateContext):Promise<{ok:true;material:AdminMaterial}|{ok:false;blockers:PublishBlocker[]}>{
    assertId(id);
    // The transition decided against one read of the row. What is published is
    // exactly the row the gate read: it is written back only if it is still that row.
    const decide=(row:Record<string,unknown>|undefined):{ok:true;material:AdminMaterial;patch:{status:MaterialLifecycleStatus;updatedAt:string}}|{ok:false;blockers:PublishBlocker[]}=>{
      if(!row)throw new Error('Material not found.');
      const reviewed=migrateStoredMaterial(row);
      const material=reviewed.material as AdminMaterial;
      if(status==='published'){
        const blockers=publishBlockers(material,{...context,needsReview:reviewed.needsReview.map(describeQuestionIssue)});
        if(blockers.length>0)return{ok:false,blockers};
      }
      const patch={status,updatedAt:nextRevision(row.updatedAt)};
      return{ok:true,material:{...material,...patch},patch};
    };

    if(useFirestore()){
      const db=getFirestoreDb();
      const ref=db.collection('admin_content').doc(section).collection('items').doc(id);
      return db.runTransaction(async tx=>{
        const snap=await tx.get(ref);
        const decision=decide(snap.exists?(snap.data() as Record<string,unknown>):undefined);
        if(!decision.ok)return decision;
        tx.set(ref,decision.patch,{merge:true});
        return{ok:true as const,material:decision.material};
      });
    }

    const gated=this.readCollection<Record<string,unknown>>(section).find(item=>item.id===id);
    const decision=decide(gated);
    if(!decision.ok)return decision;
    // The gate calls back into its context, so the row is read again before the
    // status goes onto it. A save that landed in between would otherwise be
    // published without the gate ever having read it.
    const items=this.readCollection<Record<string,unknown>>(section);
    const index=items.findIndex(item=>item.id===id);
    if(index<0)throw new Error('Material not found.');
    if(items[index].updatedAt!==gated?.updatedAt)throw new MaterialConflictError('material_changed_during_publish');
    items[index]={...items[index],...decision.patch};
    this.writeCollection(section,items);
    return{ok:true,material:decision.material};
  }
  public async getStats():Promise<AdminStats>{const [speaking,reading,listening,writing,bundles]=await Promise.all([this.listMaterials('speaking'),this.listMaterials('reading'),this.listMaterials('listening'),this.listMaterials('writing'),bundleStore.list()]);let fileCount=0,totalBytes=0;if(useFirestore()){const snap=await getFirestoreDb().collection('admin_assets').get();fileCount=snap.size;snap.docs.forEach(d=>{totalBytes+=Number(d.data().size||0);});}else if(fs.existsSync(PRIVATE_UPLOADS_DIR))for(const f of fs.readdirSync(PRIVATE_UPLOADS_DIR))try{totalBytes+=fs.statSync(path.join(PRIVATE_UPLOADS_DIR,f)).size;fileCount++;}catch{}const all=[...speaking,...reading,...listening,...writing];return{totalMaterials:all.length,publishedMaterials:all.filter(m=>m.status==='published').length,draftMaterials:all.filter(m=>m.status==='draft').length,bySection:{speaking:speaking.length,reading:reading.length,listening:listening.length,writing:writing.length},totalBundles:bundles.length,uploadedFilesCount:fileCount,uploadedTotalBytes:totalBytes};}
}
export const adminStore=new AdminStore();
// PUBLIC_UPLOADS_DIR is retained only so an existing deployment keeps its
// directory; nothing is served from it. Assets are read by id through the
// admin and learner asset routes, which check who is asking.
export {PRIVATE_UPLOADS_DIR,PUBLIC_UPLOADS_DIR};
