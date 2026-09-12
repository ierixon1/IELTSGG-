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
import { InvalidIdentifierError } from '../http/errors';

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
   */
  public async saveMaterial(section:SectionType,materialData:unknown,author='Admin'):Promise<AdminMaterial>{
    assertId(section);
    assertMaterialEnvelope(section,materialData);
    const incoming=materialData as Record<string,unknown>;
    const now=new Date().toISOString();

    if(useFirestore()){
      const db=getFirestoreDb();
      const id=incoming.id?String(incoming.id):`adm-${section.slice(0,3)}-${Date.now()}-${nanoid(5)}`;
      assertId(id);
      const ref=db.collection('admin_content').doc(section).collection('items').doc(id);
      const existing=await ref.get();
      const previous=(existing.exists?existing.data():undefined)as Record<string,unknown>|undefined;
      const item=this.finalise(section,previous,incoming,id,author,now);
      await ref.set(item,{merge:true});
      return item;
    }

    const items=this.readCollection<Record<string,unknown>>(section);
    const index=incoming.id?items.findIndex(x=>x.id===incoming.id):-1;
    const previous=index>=0?items[index]:undefined;
    const id=String(incoming.id||`adm-${section.slice(0,3)}-${Date.now()}-${nanoid(5)}`);
    assertId(id);
    const item=this.finalise(section,previous,incoming,id,author,now);
    if(index>=0)items[index]=item as unknown as Record<string,unknown>;
    else items.unshift(item as unknown as Record<string,unknown>);
    this.writeCollection(section,items);
    return item;
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
  public async deleteMaterial(section:SectionType,id:string){assertId(id);if(useFirestore()){const ref=getFirestoreDb().collection('admin_content').doc(section).collection('items').doc(id),snap=await ref.get();if(!snap.exists)return false;await ref.delete();return true;}const items=this.readCollection<any>(section),filtered=items.filter(x=>x.id!==id);if(filtered.length===items.length)return false;this.writeCollection(section,filtered);return true;}
  /**
   * Appends one reviewer decision to a generated material.
   *
   * The only write path for `generationReviews`. The whole material is validated
   * again, so a decision about a question the record does not know, or one the
   * machine did not flag, is refused here as well as at the route.
   */
  public async appendGenerationReview(section:SectionType,id:string,review:StoredGenerationReview):Promise<AdminMaterial>{
    assertId(id);
    let row:Record<string,unknown>|null=null;
    if(useFirestore()){
      const snap=await getFirestoreDb().collection('admin_content').doc(section).collection('items').doc(id).get();
      row=snap.exists?(snap.data() as Record<string,unknown>):null;
    }else{
      row=this.readCollection<Record<string,unknown>>(section).find(item=>item.id===id)||null;
    }
    if(!row)throw new Error('Material not found.');
    const content=(row.content??{}) as Record<string,unknown>;
    const existing=Array.isArray(content.generationReviews)?content.generationReviews:[];
    const next={...row,content:{...content,generationReviews:[...existing,review]},updatedAt:new Date().toISOString()};
    const parsed=parseMaterialForWrite(section,next);
    if(!parsed.ok)throw new MaterialValidationError(parsed.issues);
    const material=parsed.material as unknown as AdminMaterial;
    if(useFirestore()){
      await getFirestoreDb().collection('admin_content').doc(section).collection('items').doc(id).set(material);
    }else{
      const items=this.readCollection<Record<string,unknown>>(section);
      const index=items.findIndex(item=>item.id===id);
      if(index<0)throw new Error('Material not found.');
      items[index]=material as unknown as Record<string,unknown>;
      this.writeCollection(section,items);
    }
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
    const reviewed=await this.reviewMaterial(section,id);
    if(!reviewed)throw new Error('Material not found.');
    const material=reviewed.material;
    if(status==='published'){
      const blockers=publishBlockers(material,{...context,needsReview:reviewed.needsReview.map(describeQuestionIssue)});
      if(blockers.length>0)return{ok:false,blockers};
    }
    const now=new Date().toISOString();
    if(useFirestore()){
      const ref=getFirestoreDb().collection('admin_content').doc(section).collection('items').doc(id);
      await ref.set({status,updatedAt:now},{merge:true});
      return{ok:true,material:{...material,status,updatedAt:now}};
    }
    const items=this.readCollection<Record<string,unknown>>(section);
    const index=items.findIndex(x=>x.id===id);
    if(index<0)throw new Error('Material not found.');
    items[index]={...items[index],status,updatedAt:now};
    this.writeCollection(section,items);
    return{ok:true,material:{...material,status,updatedAt:now}};
  }
  public async getStats():Promise<AdminStats>{const [speaking,reading,listening,writing,bundles]=await Promise.all([this.listMaterials('speaking'),this.listMaterials('reading'),this.listMaterials('listening'),this.listMaterials('writing'),bundleStore.list()]);let fileCount=0,totalBytes=0;if(useFirestore()){const snap=await getFirestoreDb().collection('admin_assets').get();fileCount=snap.size;snap.docs.forEach(d=>{totalBytes+=Number(d.data().size||0);});}else if(fs.existsSync(PRIVATE_UPLOADS_DIR))for(const f of fs.readdirSync(PRIVATE_UPLOADS_DIR))try{totalBytes+=fs.statSync(path.join(PRIVATE_UPLOADS_DIR,f)).size;fileCount++;}catch{}const all=[...speaking,...reading,...listening,...writing];return{totalMaterials:all.length,publishedMaterials:all.filter(m=>m.status==='published').length,draftMaterials:all.filter(m=>m.status==='draft').length,bySection:{speaking:speaking.length,reading:reading.length,listening:listening.length,writing:writing.length},totalBundles:bundles.length,uploadedFilesCount:fileCount,uploadedTotalBytes:totalBytes};}
}
export const adminStore=new AdminStore();
// PUBLIC_UPLOADS_DIR is retained only so an existing deployment keeps its
// directory; nothing is served from it. Assets are read by id through the
// admin and learner asset routes, which check who is asking.
export {PRIVATE_UPLOADS_DIR,PUBLIC_UPLOADS_DIR};
