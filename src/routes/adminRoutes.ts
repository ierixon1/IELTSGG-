import express,{Request,Response,NextFunction} from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import {nanoid} from 'nanoid';
import mammoth from 'mammoth';
import sanitizeHtml from 'sanitize-html';
import {adminStore,PRIVATE_UPLOADS_DIR} from '../services/adminStore';
import {toPublicMaterialSummary} from '../services/publicMaterialView';
import {namespaceCdiId} from '../utils/cdiIds';
import {describeQuestionIssue} from '../schemas/question';
import {importCdiHtml} from '../services/cdiImport';
import {toDraftMaterial} from '../services/cdiImport/toMaterial';
import {assetStore,extractAssetIds,isAssetId} from '../services/assetStore';
import {publishBlockers,describePublishBlockers} from '../services/publishGate';
import type {MaterialLifecycleStatus} from '../types/admin';
import {MaterialValidationError} from '../services/adminStore';
import {validateUpload,EXTENSION_EXPECTATIONS} from '../services/fileTypeSniffer';
import type {UploadedAssetSummary} from '../types/asset';
import {authService} from '../services/authService';
import {storageProvider} from '../services/storage';

export const adminRouter=express.Router();
type AdminRequest=Request&{adminUser?:{id:string;username:string;displayName:string;role:string};adminSessionToken?:string};
const ADMIN_AUTH_COOKIE='prep_admin_auth';
const readCookie=(req:Request,name:string)=>{const header=req.headers.cookie||'';for(const part of header.split(';')){const [k,...v]=part.trim().split('=');if(k===name)return decodeURIComponent(v.join('='));}return '';};
const isSection=(v:unknown):v is 'speaking'|'reading'|'listening'|'writing'=>['speaking','reading','listening','writing'].includes(String(v));
const BINARY_MAGIC_SIGNATURES=[[0x4d,0x5a],[0x7f,0x45,0x4c,0x46],[0xfe,0xed,0xfa,0xce],[0xfe,0xed,0xfa,0xcf],[0xca,0xfe,0xba,0xbe],[0x50,0x4b,0x03,0x04],[0x25,0x50,0x44,0x46],[0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a],[0xff,0xd8,0xff],[0x47,0x49,0x46,0x38],[0x52,0x49,0x46,0x46],[0x1f,0x8b],[0x37,0x7a,0xbc,0xaf,0x27,0x1c],[0x52,0x61,0x72,0x21],[0xfd,0x37,0x7a,0x58,0x5a,0x00],[0x42,0x5a,0x68]];
export function validateHtmlFileBuffer(buffer:Buffer){if(!buffer?.length)return{valid:false,error:'File is empty.'};if(buffer.length>5*1024*1024)return{valid:false,error:'HTML file exceeds the 5MB size limit.'};for(const sig of BINARY_MAGIC_SIGNATURES)if(buffer.length>=sig.length&&sig.every((b,i)=>buffer[i]===b))return{valid:false,error:'Disguised binary file detected.'};if(buffer.includes(0))return{valid:false,error:'Binary null bytes detected.'};for(let i=0;i<Math.min(buffer.length,8192);i++){const b=buffer[i];if(b<9||b===11||b===12||(b>=14&&b<=31)||b===127)return{valid:false,error:'Unprintable binary control bytes detected.'};}try{const text=new TextDecoder('utf-8',{fatal:true}).decode(buffer);if(!/<(!DOCTYPE|html|head|body|p|div|table|h[1-6]|span|section|article|main|ul|ol|b|strong|em|i)\b/i.test(text))return{valid:false,error:'No recognized HTML structure found.'};}catch{return{valid:false,error:'Invalid UTF-8 byte sequence.'}}return{valid:true};}
const SAFE_CLASS_PATTERNS=[/^cdi-[\w-]+$/,/^text-(left|right|center|justify|xs|sm|base|lg|slate|gray|neutral|zinc|black|red|emerald|amber|indigo)$/,/^font-(serif|sans|mono|bold|semibold|normal|medium)$/,/^(italic|underline|line-through)$/,/^p[xytb]?-[0-8]$/,/^m[xytb]?-[0-8]$/,/^border(?:-[a-z0-9-]+)?$/,/^bg-[a-z0-9-]+$/,/^(table|table-[a-z]+|w-full|h-auto|max-w-[a-z0-9]+)$/,/^list-[a-z]+$/,/^space-[xy]-[0-8]$/];
const SAFE_STYLE_RULES:Record<string,RegExp[]>={
 'text-align':[/^(left|right|center|justify)$/i],'vertical-align':[/^(top|middle|bottom|baseline)$/i],'font-weight':[/^(bold|normal|[1-9]00)$/i],'font-style':[/^(italic|normal)$/i],'text-decoration':[/^(underline|line-through|none)$/i],
 'width':[/^\d+(?:\.\d+)?(?:px|%|em|rem|ch)$/i],'max-width':[/^\d+(?:\.\d+)?(?:px|%|em|rem|ch)$/i],'min-width':[/^\d+(?:\.\d+)?(?:px|%|em|rem|ch)$/i],'height':[/^\d+(?:\.\d+)?(?:px|%|em|rem|ch)$/i],
 'padding':[/^[0-9.]+(?:px|%|em|rem)(?:\s+[0-9.]+(?:px|%|em|rem))*$/i],'padding-left':[/^[0-9.]+(?:px|%|em|rem)$/i],'padding-right':[/^[0-9.]+(?:px|%|em|rem)$/i],'padding-top':[/^[0-9.]+(?:px|%|em|rem)$/i],'padding-bottom':[/^[0-9.]+(?:px|%|em|rem)$/i],
 'margin':[/^(auto|[0-9.]+(?:px|%|em|rem)(?:\s+[0-9.]+(?:px|%|em|rem))*)$/i],'margin-left':[/^(auto|[0-9.]+(?:px|%|em|rem))$/i],'margin-right':[/^(auto|[0-9.]+(?:px|%|em|rem))$/i],'margin-top':[/^(auto|[0-9.]+(?:px|%|em|rem))$/i],'margin-bottom':[/^(auto|[0-9.]+(?:px|%|em|rem))$/i],
 'border':[/^[0-9a-zA-Z\s#(),.-]+$/i],'border-top':[/^[0-9a-zA-Z\s#(),.-]+$/i],'border-bottom':[/^[0-9a-zA-Z\s#(),.-]+$/i],'border-left':[/^[0-9a-zA-Z\s#(),.-]+$/i],'border-right':[/^[0-9a-zA-Z\s#(),.-]+$/i],'border-collapse':[/^(collapse|separate)$/i],'border-spacing':[/^[0-9px\s]+$/i],
 'color':[/^(#[0-9a-fA-F]{3,8}|rgb\([0-9\s,]+\)|rgba\([0-9\s,.]+\)|[a-zA-Z]+)$/i],'background-color':[/^(#[0-9a-fA-F]{3,8}|rgb\([0-9\s,]+\)|rgba\([0-9\s,.]+\)|transparent|[a-zA-Z]+)$/i]
};
// Imported markup must not be able to shadow the app's own elements: a node
// with id="root" or id="btn-recalculate-plan" wins document.getElementById and
// window named access. Every id is namespaced, and same-document links are
// rewritten to match so a CDI page's internal anchors still resolve.
const sanitizeClass=(value:string)=>value.split(/\s+/).filter(v=>SAFE_CLASS_PATTERNS.some(p=>p.test(v))).join(' ');
const sanitizeStyle=(value:string)=>value.split(';').map(part=>{const [key,...rest]=part.split(':');const prop=key?.trim().toLowerCase();const val=rest.join(':').trim();return prop&&val&&SAFE_STYLE_RULES[prop]?.some(r=>r.test(val))&&!/[()@]|url|expression|javascript/i.test(val)?`${prop}:${val}`:''}).filter(Boolean).join(';');
export const sanitizeHtmlServer=(rawHtml:string)=>sanitizeHtml(typeof rawHtml==='string'?rawHtml:'',{allowedTags:['h1','h2','h3','h4','h5','h6','p','br','hr','strong','b','em','i','u','s','del','mark','small','sub','sup','span','div','blockquote','q','pre','code','ul','ol','li','dl','dt','dd','table','thead','tbody','tfoot','tr','th','td','caption','col','colgroup','img','a','figure','figcaption','section','article','aside','header','footer','nav','main','details','summary'],allowedAttributes:{'*':['class','id','style','title','lang','dir'],img:['src','alt','width','height','loading'],a:['href','target','rel'],th:['colspan','rowspan','headers','scope'],td:['colspan','rowspan','headers','scope']},allowedStyles:{'*':SAFE_STYLE_RULES},allowedSchemes:['http','https','mailto'],allowedSchemesByTag:{img:['data']},allowProtocolRelative:false,transformTags:{img:(tagName,attribs)=>{const src=(attribs.src||'').trim();const local=src.startsWith('/api/assets/ast_');const inline=/^data:image\/(png|jpeg|jpg|webp|gif);base64,/i.test(src);if(!local&&!inline)return{tagName:'span',attribs:{class:'cdi-blocked-img text-ink-400 italic text-xs block my-2 p-2 border border-dashed border-ink-300 rounded bg-ink-50'},text:'[External image blocked]'};return{tagName,attribs};},a:(tagName,attribs)=>{const href=String(attribs.href||'').trim();if(href.startsWith('#')){const id=namespaceCdiId(href.slice(1));const out:Record<string,string>={...attribs};if(id)out.href='#'+id;else delete out.href;return{tagName,attribs:out};}return{tagName,attribs:{...attribs,target:'_blank',rel:'noopener noreferrer nofollow'}};},'*':(tagName,attribs)=>{if(typeof attribs.class==='string')attribs.class=sanitizeClass(attribs.class);if(typeof attribs.style==='string')attribs.style=sanitizeStyle(attribs.style);if(typeof attribs.id==='string'){const id=namespaceCdiId(attribs.id);if(id)attribs.id=id;else delete attribs.id;}return{tagName,attribs};}},disallowedTagsMode:'discard'});
export function deepSanitizeHtml(obj:any):any{if(!obj||typeof obj!=='object')return obj;if(Array.isArray(obj))return obj.map(deepSanitizeHtml);const out:any={};for(const[k,v]of Object.entries(obj))out[k]=(k==='htmlContent'||k==='passageHtml')&&typeof v==='string'?sanitizeHtmlServer(v):v&&typeof v==='object'?deepSanitizeHtml(v):v;return out;}
export async function requireAdminAuth(req:AdminRequest,res:Response,next:NextFunction){try{const token=readCookie(req,ADMIN_AUTH_COOKIE);if(!token)return res.status(403).json({error:'Forbidden.'});const session=await authService.validateSession(token);if(!session||(session.role!== 'admin'&&session.role!== 'examiner'))return res.status(403).json({error:'Forbidden.'});req.adminSessionToken=token;req.adminUser={id:session.userId,username:session.username,displayName:session.name,role:session.role};return next();}catch{return res.status(403).json({error:'Forbidden.'});}}
export function requireAdminRole(req:AdminRequest,res:Response,next:NextFunction){if(req.adminUser?.role!=='admin')return res.status(403).json({error:'Administrator role required.'});return next();}
// Uploads are held in memory and handed to the asset store, which decides
// the storage path from a generated id. Nothing is ever written under a
// caller-supplied filename, and the original bytes are never overwritten.
const ALLOWED_UPLOAD_EXTENSIONS=Object.keys(EXTENSION_EXPECTATIONS);
// multer reads the SECOND argument as "accept this file"; cb(null) leaves it
// undefined, which silently rejects every upload.
const fileFilter:multer.Options['fileFilter']=(_r,file,cb)=>{
  const ext=path.extname(file.originalname).toLowerCase();
  if(ALLOWED_UPLOAD_EXTENSIONS.includes(ext))return cb(null,true);
  return cb(new Error(`Unsupported file type: ${ext||'unknown'}`));
};
const upload=multer({storage:multer.memoryStorage(),fileFilter,limits:{fileSize:35*1024*1024,files:1,fields:20,fieldNameSize:100,fieldSize:256*1024,parts:22}});
adminRouter.post('/login',async(req,res)=>{try{const r=await authService.login(String(req.body?.username||''),String(req.body?.password||''));if(r.user.role!=='admin'&&r.user.role!=='examiner')return res.status(403).json({error:'Forbidden.'});res.cookie(ADMIN_AUTH_COOKIE,r.token,{httpOnly:true,sameSite:'strict',secure:process.env.NODE_ENV==='production',path:'/api/admin',maxAge:24*60*60*1000});return res.json({success:true,admin:{id:r.user.id,username:r.user.username,name:r.user.name,role:r.user.role}});}catch{return res.status(401).json({error:'Invalid credentials.'});}});
adminRouter.get('/me',requireAdminAuth,(req:AdminRequest,res)=>res.json({admin:req.adminUser}));
adminRouter.post('/logout',requireAdminAuth,async(req:AdminRequest,res)=>{try{await authService.logout(req.adminSessionToken||'');}catch{}res.clearCookie(ADMIN_AUTH_COOKIE,{httpOnly:true,sameSite:'strict',secure:process.env.NODE_ENV==='production',path:'/api/admin'});return res.json({success:true});});
/**
 * Serves an asset to an administrator.
 *
 * The stored MIME type is sniffed from the bytes, never taken from the upload,
 * and only media types an admin needs to preview are served inline. Everything
 * else — documents, and imported HTML above all — is a download with a neutral
 * type, so an uploaded page can never execute on this origin.
 */
const INLINE_PREVIEW_TYPES=new Set(['image/png','image/jpeg','image/gif','image/webp','audio/mpeg','audio/wav','audio/ogg','application/pdf']);
function sendAsset(res:Response,asset:{mimeType:string;originalName:string},data:Buffer){
  const inline=INLINE_PREVIEW_TYPES.has(asset.mimeType);
  const filename=asset.originalName.replace(/[^w. -]/g,'_').slice(0,120)||'download';
  res.setHeader('Content-Type',inline?asset.mimeType:'application/octet-stream');
  res.setHeader('Content-Disposition',`${inline?'inline':'attachment'}; filename="${filename}"`);
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Content-Security-Policy',"default-src 'none'; sandbox");
  return res.send(data);
}
export {sendAsset};
adminRouter.get('/assets/:id',requireAdminAuth,async(req,res)=>{try{const asset=await assetStore.get(req.params.id);if(!asset)return res.status(404).json({error:'Asset not found.'});return sendAsset(res,asset,await assetStore.readContent(asset));}catch{return res.status(404).json({error:'Asset not found.'});}});
adminRouter.get('/assets',requireAdminAuth,async(_req,res)=>{try{return res.json({items:await assetStore.list()});}catch{return res.status(500).json({error:'Unable to list assets.'});}});
adminRouter.post('/assets/reap',requireAdminAuth,requireAdminRole,async(_req,res)=>{try{return res.json({removed:await assetStore.reapUnreferenced()});}catch(error){console.error('[Assets] reap failed:',error);return res.status(500).json({error:'Unable to reap assets.'});}});
adminRouter.get('/stats',requireAdminAuth,async(_req,res)=>{try{return res.json({stats:await adminStore.getStats()});}catch{return res.status(500).json({error:'Unable to load stats.'});}});
/**
 * Accepts one file, verifies it really is what it claims, and stores it as a
 * staged asset.
 *
 * For HTML both versions are kept: the untouched original as a private asset
 * that is never served to a browser, and the sanitised markup returned to the
 * editor. Overwriting the original with the sanitised output — which is what
 * used to happen — makes it impossible to re-run a better parser over it later.
 */
adminRouter.post('/upload',requireAdminAuth,requireAdminRole,upload.single('file'),async(req:AdminRequest,res)=>{
  const file=(req as any).file as {originalname:string;mimetype?:string;buffer:Buffer}|undefined;
  if(!file?.buffer?.length)return res.status(400).json({error:'No file was uploaded.'});
  const extension=path.extname(file.originalname).toLowerCase();
  const verdict=validateUpload({extension,declaredMimeType:file.mimetype,buffer:file.buffer});
  if(verdict.ok!==true)return res.status(400).json({error:verdict.error});
  try{
    const createdBy=req.adminUser?.id||'admin';
    const original=await assetStore.create({originalName:file.originalname,content:file.buffer,mimeType:verdict.mimeType,kind:verdict.kind,createdBy,sourceType:'upload'});
    const summary:UploadedAssetSummary={assetId:original.id,originalName:original.originalName,size:original.size,mimeType:original.mimeType,kind:original.kind,url:`/api/admin/assets/${original.id}`};

    if(verdict.kind==='html'){
      const check=validateHtmlFileBuffer(file.buffer);
      if(!check.valid)return res.status(400).json({error:check.error});
      const sanitized=sanitizeHtmlServer(file.buffer.toString('utf8'));
      const derived=await assetStore.create({originalName:`${original.originalName}.sanitized.html`,content:Buffer.from(sanitized,'utf8'),mimeType:'text/html',kind:'html',createdBy,sourceType:'derived',derivedFromAssetId:original.id});
      summary.assetId=derived.id;
      summary.url=`/api/admin/assets/${derived.id}`;
      summary.sourceAssetId=original.id;
      summary.extractedHtml=sanitized;
      summary.extractedText=sanitized.replace(/<[^>]+>/g,' ').replace(/s+/g,' ').trim()||undefined;
    }else if(verdict.mimeType==='text/plain'){
      summary.extractedText=file.buffer.toString('utf8').trim()||undefined;
    }else if(extension==='.docx'){
      try{const r=await mammoth.extractRawText({buffer:file.buffer});summary.extractedText=(r.value||'').trim()||undefined;}
      catch(error){console.warn('[Upload] DOCX text extraction failed:',error);summary.extractionError='Text could not be extracted from this document.';}
    }else if(extension==='.pdf'){
      try{const mod=await import('pdf-parse');const fn=(mod as any).default||(mod as any).PDFParse||mod;if(typeof fn==='function'){const r=await fn(file.buffer);summary.extractedText=(r.text||'').trim()||undefined;}}
      catch(error){console.warn('[Upload] PDF text extraction failed:',error);summary.extractionError='Text could not be extracted from this PDF.';}
    }

    return res.json({success:true,file:summary,asset:summary});
  }catch(error){console.error('[Upload] failed:',error);return res.status(500).json({error:'File upload failed.'});}
});

/**
 * Analyses a pasted or uploaded CDI page and reports what could be read from it.
 *
 * This endpoint only *reads*. It stores the original bytes — so a better parser
 * can be run over them later — and stores any asset the page carries inline,
 * because those cannot be recovered once the page is discarded. It saves no
 * material: what comes back is a draft plus every reason it is not finished,
 * and phase 7 is where a human turns that into published content.
 *
 * The page is never executed. Script is removed during normalisation, and the
 * display markup goes through the same sanitiser as any other imported HTML.
 */
adminRouter.post('/import/html',requireAdminAuth,requireAdminRole,async(req:AdminRequest,res)=>{
  const raw=typeof req.body?.html==='string'?req.body.html:typeof req.body==='string'?req.body:'';
  if(!raw.trim())return res.status(400).json({error:'No HTML was supplied.'});

  const buffer=Buffer.from(raw,'utf8');
  const check=validateHtmlFileBuffer(buffer);
  if(!check.valid)return res.status(400).json({error:check.error});

  try{
    const createdBy=req.adminUser?.id||'admin';
    // The untouched original, kept private and never served as a page.
    const sourceAsset=await assetStore.create({originalName:String(req.body?.filename||'pasted-import.html').slice(0,200),content:buffer,mimeType:'text/html',kind:'html',createdBy,sourceType:req.body?.filename?'upload':'paste'});

    const stored:Array<{originalSrc:string;assetId:string}>=[];
    const result=importCdiHtml(raw,{
      resolveAsset:(asset)=>{
        // Only what the page actually contains can be stored. A path or an
        // external URL is reported instead, never fetched.
        if(asset.origin!=='inline'||!asset.inlineData)return null;
        const id=`pending-${stored.length}`;
        stored.push({originalSrc:asset.originalSrc,assetId:id});
        return id;
      },
    });

    // Inline assets are written after parsing, then their real ids are patched
    // in — so a parse that throws does not leave files behind.
    for(const entry of stored){
      const asset=result.assets.find(a=>a.originalSrc===entry.originalSrc);
      if(!asset?.inlineData)continue;
      const created=await assetStore.create({originalName:`imported-${asset.kind}`,content:Buffer.from(asset.inlineData.base64,'base64'),mimeType:asset.inlineData.mimeType,kind:asset.kind,createdBy,sourceType:'derived',derivedFromAssetId:sourceAsset.id});
      asset.assetId=created.id;
      for(const question of result.questions){
        if(question.question?.mediaRef?.assetId===entry.assetId)question.question.mediaRef.assetId=created.id;
        if(question.draft?.mediaRef?.assetId===entry.assetId)question.draft.mediaRef.assetId=created.id;
      }
    }

    const draft=toDraftMaterial(result,{sourceAssetId:sourceAsset.id});
    return res.json({
      parserVersion:result.parserVersion,
      sourceAssetId:sourceAsset.id,
      detectedSection:result.detectedSection,
      title:result.title,
      material:draft,
      questions:result.questions,
      assets:result.assets.map(({inlineData:_inlineData,...rest})=>rest),
      unsupportedRegions:result.unsupportedRegions,
      diagnostics:result.diagnostics,
      transcript:result.transcript,
      stats:result.stats,
      needsReview:result.stats.needsReview+result.stats.unsupported,
    });
  }catch(error){
    console.error('[Import] failed:',error);
    return res.status(500).json({error:'The page could not be analysed.'});
  }
});
adminRouter.get('/materials',requireAdminAuth,async(req,res)=>{
  const status=['all','published','draft','archived'].includes(String(req.query.status))?String(req.query.status) as 'all'|'published'|'draft'|'archived':undefined;
  const requested=req.query.section;
  const sections=isSection(requested)?[requested]:(['speaking','reading','listening','writing'] as const);
  const reviewed=(await Promise.all(sections.map(section=>adminStore.reviewMaterials(section,status)))).flat();
  // `needsReview` is computed, never stored: it lists the questions a stored
  // material still carries that cannot be made canonical. Nothing is invented
  // to fill the gap, so these need a human.
  return res.json({items:reviewed.map(entry=>entry.needsReview.length>0?{...entry.material,needsReview:entry.needsReview.map(describeQuestionIssue)}:entry.material)});
});
adminRouter.get('/materials/:section/:id',requireAdminAuth,async(req,res)=>{if(!isSection(req.params.section))return res.status(400).json({error:'Invalid section.'});const item=await adminStore.getMaterial(req.params.section,req.params.id);return item?res.json({item}):res.status(404).json({error:'Material not found.'});});
/**
 * Saves a material and settles its assets in one step.
 *
 * Promotion happens here rather than at upload time because that is the moment
 * a file stops being a loose upload and becomes part of published content.
 * `reconcile` then releases anything the edit dropped, so replacing an audio
 * file does not leave the old one pinned as active forever.
 */
async function saveMaterialWithAssets(section:'speaking'|'reading'|'listening'|'writing',body:unknown,author:string){
  const item=await adminStore.saveMaterial(section,body,author);
  try{
    await assetStore.promote(extractAssetIds(item));
    await assetStore.reconcile();
  }catch(error){console.error('[Assets] reconcile after save failed:',error);}
  return item;
}

/**
 * Deletes a material and releases the assets nothing else references.
 *
 * Refused while a bundle still names the material: resolving that slot to null
 * makes the learner sit built-in content under the bundle's own title, which is
 * worse than refusing the delete.
 */
async function deleteMaterialWithAssets(section:'speaking'|'reading'|'listening'|'writing',id:string){
  const material=await adminStore.getMaterial(section,id);
  if(!material)return {ok:false as const,status:404,error:'Material not found.'};
  if(material.status==='published'){
    // A published material is reachable from the learner catalog by id, so
    // deleting it breaks a link somebody may be looking at right now. Retiring
    // it is the supported move: `archive` keeps past attempts meaningful while
    // putting it out of reach.
    return {ok:false as const,status:409,error:'This material is published. Unpublish or archive it before deleting.'};
  }
  const bundles=await adminStore.listBundles();
  const blocking=bundles.filter(b=>Object.values(b.materials||{}).includes(id));
  if(blocking.length>0){
    return {ok:false as const,status:409,error:`This material is used by ${blocking.length} CDI bundle(s): ${blocking.map(b=>b.title).join(', ')}. Remove it from them first.`};
  }
  const deleted=await adminStore.deleteMaterial(section,id);
  if(!deleted)return {ok:false as const,status:404,error:'Material not found.'};
  let released:string[]=[];
  try{released=await assetStore.releaseForDeletedMaterial(material);}
  catch(error){console.error('[Assets] release after delete failed:',error);}
  return {ok:true as const,released};
}

/**
 * Saves a material, answering 400 with the specific reason when it is not
 * canonical. "Save failed" is not an actionable message when the cause is one
 * question with an answer that is not among its own options.
 */
async function respondWithSave(res:Response,section:'speaking'|'reading'|'listening'|'writing',body:unknown,author:string){
  // `status` is stripped rather than validated: the editors no longer send it,
  // and a request that does is trying to publish through the back door. The
  // store keeps whatever the material already had.
  if(body&&typeof body==='object'&&!Array.isArray(body)){
    const {status:_ignored,...rest}=body as Record<string,unknown>;
    body=rest;
  }
  try{
    return res.json({success:true,item:await saveMaterialWithAssets(section,body,author)});
  }catch(error){
    if(error instanceof MaterialValidationError)return res.status(400).json({error:'Material failed validation.',issues:error.issues});
    console.error('[Materials] save failed:',error);
    return res.status(400).json({error:error instanceof Error?error.message:'Unable to save material.'});
  }
}
adminRouter.post('/materials',requireAdminAuth,requireAdminRole,async(req:AdminRequest,res)=>{if(!isSection(req.body?.section))return res.status(400).json({error:'Valid section is required.'});return respondWithSave(res,req.body.section,deepSanitizeHtml(req.body),req.adminUser?.displayName||'Admin');});
adminRouter.post('/materials/:section',requireAdminAuth,requireAdminRole,async(req:AdminRequest,res)=>{if(!isSection(req.params.section))return res.status(400).json({error:'Invalid section.'});return respondWithSave(res,req.params.section,deepSanitizeHtml(req.body),req.adminUser?.displayName||'Admin');});
adminRouter.put('/materials/:id',requireAdminAuth,requireAdminRole,async(req:AdminRequest,res)=>{if(!isSection(req.body?.section))return res.status(400).json({error:'Valid section is required.'});return respondWithSave(res,req.body.section,{...deepSanitizeHtml(req.body),id:req.params.id},req.adminUser?.displayName||'Admin');});
adminRouter.put('/materials/:section/:id',requireAdminAuth,requireAdminRole,async(req:AdminRequest,res)=>{if(!isSection(req.params.section))return res.status(400).json({error:'Invalid section.'});return respondWithSave(res,req.params.section,{...deepSanitizeHtml(req.body),id:req.params.id},req.adminUser?.displayName||'Admin');});
adminRouter.delete('/materials/:id',requireAdminAuth,requireAdminRole,async(req,res)=>{for(const section of ['speaking','reading','listening','writing'] as const){if(await adminStore.getMaterial(section,req.params.id)){const result=await deleteMaterialWithAssets(section,req.params.id);return result.ok?res.json({success:true,releasedAssets:result.released}):res.status(result.status).json({error:result.error});}}return res.status(404).json({error:'Material not found.'});});
adminRouter.delete('/materials/:section/:id',requireAdminAuth,requireAdminRole,async(req,res)=>{if(!isSection(req.params.section))return res.status(400).json({error:'Invalid section.'});const result=await deleteMaterialWithAssets(req.params.section,req.params.id);return result.ok?res.json({success:true,releasedAssets:result.released}):res.status(result.status).json({error:result.error});});
/**
 * Whether the assets a material names are still in the store.
 *
 * Read once per publish attempt rather than per asset, so a material with a
 * dozen images does not turn one button press into a dozen round trips.
 */
async function assetPresence(){
  const assets=await assetStore.list();
  const present=new Set(assets.map(asset=>asset.id));
  return {assetExists:(id:string)=>present.has(id)};
}

/**
 * Why this material cannot be published, without publishing it.
 *
 * The catalog calls this to show the blockers next to the material, so an
 * admin sees what has to be fixed before pressing anything.
 */
adminRouter.get('/materials/:section/:id/publish-check',requireAdminAuth,async(req,res)=>{
  if(!isSection(req.params.section))return res.status(400).json({error:'Invalid section.'});
  const reviewed=await adminStore.reviewMaterial(req.params.section,req.params.id);
  if(!reviewed)return res.status(404).json({error:'Material not found.'});
  const blockers=publishBlockers(reviewed.material,{
    ...(await assetPresence()),
    needsReview:reviewed.needsReview.map(describeQuestionIssue),
  });
  return res.json({publishable:blockers.length===0,blockers});
});

/**
 * The lifecycle transitions, as their own verbs.
 *
 * `publish` is the only one that can be refused: it answers 409 with the list
 * of reasons rather than a bare failure, because "cannot publish" is useless
 * to somebody who has to fix it. Unpublishing and archiving always succeed —
 * taking broken material away from learners must never be the harder path.
 */
const LIFECYCLE_ACTIONS:Record<string,MaterialLifecycleStatus>={publish:'published',unpublish:'draft',archive:'archived',restore:'draft'};
adminRouter.post('/materials/:section/:id/:action(publish|unpublish|archive|restore)',requireAdminAuth,requireAdminRole,async(req,res)=>{
  if(!isSection(req.params.section))return res.status(400).json({error:'Invalid section.'});
  const status=LIFECYCLE_ACTIONS[req.params.action];
  if(!status)return res.status(400).json({error:'Unknown lifecycle action.'});
  try{
    const result=await adminStore.setMaterialStatus(req.params.section,req.params.id,status,await assetPresence());
    if(!result.ok){
      return res.status(409).json({error:'This material is not ready to be published.',blockers:result.blockers,issues:describePublishBlockers(result.blockers)});
    }
    return res.json({success:true,item:result.material});
  }catch(error){
    if(error instanceof Error&&error.message==='Material not found.')return res.status(404).json({error:error.message});
    console.error('[Materials] lifecycle change failed:',error);
    return res.status(400).json({error:error instanceof Error?error.message:'Unable to change status.'});
  }
});
adminRouter.get('/bundles',requireAdminAuth,async(req,res)=>res.json({bundles:await adminStore.listBundles(['all','published','draft'].includes(String(req.query.status))?String(req.query.status) as any:undefined)}));
adminRouter.get('/bundles/:id',requireAdminAuth,async(req,res)=>{const x=await adminStore.getResolvedBundle(req.params.id);return x?res.json(x):res.status(404).json({error:'CDI Bundle not found.'});});
adminRouter.post('/bundles',requireAdminAuth,requireAdminRole,async(req,res)=>res.json({success:true,bundle:await adminStore.saveBundle(deepSanitizeHtml(req.body))}));
adminRouter.put('/bundles/:id',requireAdminAuth,requireAdminRole,async(req,res)=>res.json({success:true,bundle:await adminStore.saveBundle({...deepSanitizeHtml(req.body),id:req.params.id})}));
adminRouter.delete('/bundles/:id',requireAdminAuth,requireAdminRole,async(req,res)=>await adminStore.deleteBundle(req.params.id)?res.json({success:true}):res.status(404).json({error:'Bundle not found.'}));
// ---------------------------------------------------------------------------
// Anonymous routes. These sit behind no session at all, so they carry metadata
// only: never an answer key, never a marking explanation, never a Listening
// transcript. A learner who is actually sitting a test reads the full material
// from /api/learner/* instead, which requires a session.
// ---------------------------------------------------------------------------
adminRouter.get('/public/materials/:section',async(req,res)=>{if(!isSection(req.params.section))return res.status(400).json({error:'Invalid section.'});const items=await adminStore.listMaterials(req.params.section,'published');return res.json({items:items.map(toPublicMaterialSummary)});});
adminRouter.get('/public/bundles',async(_req,res)=>res.json({bundles:await adminStore.listBundles('published')}));
adminRouter.get('/public/bundles/:id',async(req,res)=>{const x=await adminStore.getResolvedBundle(req.params.id);if(!x||x.bundle.status!=='published')return res.status(404).json({error:'Published CDI exam not found.'});const resolvedMaterials=Object.fromEntries(Object.entries(x.resolvedMaterials).map(([k,v])=>[k,v?toPublicMaterialSummary(v):null]));return res.json({bundle:x.bundle,resolvedMaterials});});
