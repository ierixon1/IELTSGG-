import express, { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { nanoid } from 'nanoid';
import mammoth from 'mammoth';
import sanitizeHtml from 'sanitize-html';
import { adminStore, UPLOADS_DIR } from '../services/adminStore';
import { authService } from '../services/authService';

export const adminRouter = express.Router();

type AdminRequest = Request & { adminUser?: { id: string; username: string; displayName: string; role: string } };
const isSection = (value: unknown): value is 'speaking'|'reading'|'listening'|'writing' => ['speaking','reading','listening','writing'].includes(String(value));

const BINARY_MAGIC_SIGNATURES = [
  [0x4d,0x5a],[0x7f,0x45,0x4c,0x46],[0xfe,0xed,0xfa,0xce],[0xfe,0xed,0xfa,0xcf],[0xca,0xfe,0xba,0xbe],
  [0x50,0x4b,0x03,0x04],[0x25,0x50,0x44,0x46],[0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a],[0xff,0xd8,0xff],[0x47,0x49,0x46,0x38],
  [0x52,0x49,0x46,0x46],[0x1f,0x8b],[0x37,0x7a,0xbc,0xaf,0x27,0x1c],[0x52,0x61,0x72,0x21],[0xfd,0x37,0x7a,0x58,0x5a,0x00],[0x42,0x5a,0x68]
];

export function validateHtmlFileBuffer(buffer: Buffer): { valid: boolean; error?: string } {
  if (!buffer?.length) return { valid:false, error:'File is empty.' };
  if (buffer.length > 5*1024*1024) return { valid:false, error:'HTML file exceeds the 5MB size limit.' };
  for (const sig of BINARY_MAGIC_SIGNATURES) if (buffer.length >= sig.length && sig.every((b,i)=>buffer[i]===b)) return { valid:false, error:'Disguised binary file detected.' };
  if (buffer.includes(0)) return { valid:false, error:'Binary null bytes detected.' };
  for (let i=0;i<Math.min(buffer.length,8192);i++){const b=buffer[i];if(b<9||b===11||b===12||(b>=14&&b<=31)||b===127)return{valid:false,error:'Unprintable binary control bytes detected.'};}
  let text='';
  try { text = new TextDecoder('utf-8',{fatal:true}).decode(buffer); } catch { return {valid:false,error:'Invalid UTF-8 byte sequence.'}; }
  if (!/<(!DOCTYPE|html|head|body|p|div|table|h[1-6]|span|section|article|main|ul|ol|b|strong|em|i)\b/i.test(text)) return {valid:false,error:'No recognized HTML structure found.'};
  return {valid:true};
}

export const sanitizeHtmlServer = (rawHtml: string): string => sanitizeHtml(typeof rawHtml==='string'?rawHtml:'', {
  allowedTags:['h1','h2','h3','h4','h5','h6','p','br','hr','strong','b','em','i','u','s','del','mark','small','sub','sup','span','div','blockquote','q','pre','code','ul','ol','li','dl','dt','dd','table','thead','tbody','tfoot','tr','th','td','caption','col','colgroup','img','a','figure','figcaption','section','article','aside','header','footer','nav','main','details','summary'],
  allowedAttributes:{'*':['class','id','style','title','lang','dir'],img:['src','alt','width','height','loading'],a:['href','target','rel'],th:['colspan','rowspan','headers','scope'],td:['colspan','rowspan','headers','scope']},
  allowedStyles:{'*':{'text-align':[/^(left|right|center|justify)$/i],'vertical-align':[/^(top|middle|bottom|baseline)$/i],'font-weight':[/^(bold|normal|[1-9]00)$/i],'font-style':[/^(italic|normal)$/i],'text-decoration':[/^(underline|line-through|none)$/i],'width':[/^\d+(?:\.\d+)?(?:px|%|em|rem|ch)$/i],'max-width':[/^\d+(?:\.\d+)?(?:px|%|em|rem|ch)$/i],'min-width':[/^\d+(?:\.\d+)?(?:px|%|em|rem|ch)$/i],'height':[/^\d+(?:\.\d+)?(?:px|%|em|rem|ch)$/i],'padding':[/^[0-9.]+(?:px|%|em|rem)(\s+[0-9.]+(?:px|%|em|rem))*$/i],'margin':[/^(auto|[0-9.]+(?:px|%|em|rem)(\s+[0-9.]+(?:px|%|em|rem))*)$/i],'border':[/^[0-9a-zA-Z\s#(),.-]+$/i],'border-collapse':[/^(collapse|separate)$/i],'border-spacing':[/^[0-9px\s]+$/i],'color':[/^(#[0-9a-fA-F]{3,8}|rgb\([0-9\s,]+\)|rgba\([0-9\s,.]+\)|[a-zA-Z]+)$/i],'background-color':[/^(#[0-9a-fA-F]{3,8}|rgb\([0-9\s,]+\)|rgba\([0-9\s,.]+\)|transparent|[a-zA-Z]+)$/i]}},
  allowedClasses:{'*':[/^cdi-[\w-]+$/,/^(text|font|bg|border|table|list|space|p|m|w|h|max-w)-[a-zA-Z0-9-]+$/]},
  transformTags:{img:(tagName,attribs)=>{const src=(attribs.src||'').trim();if(!src.startsWith('/api/uploads/')&&!/^data:image\/(png|jpeg|jpg|webp|gif);base64,/i.test(src))return{tagName:'span',attribs:{class:'cdi-blocked-img text-slate-400 italic'},text:'[External image blocked]'};return{tagName,attribs};},a:(tagName,attribs)=>{attribs.target='_blank';attribs.rel='noopener noreferrer nofollow';return{tagName,attribs};}},
  allowedSchemes:['http','https','mailto','data'],allowedSchemesByTag:{img:['data']},allowProtocolRelative:false,disallowedTagsMode:'discard'
});

export function deepSanitizeHtml(obj:any):any{if(!obj||typeof obj!=='object')return obj;if(Array.isArray(obj))return obj.map(deepSanitizeHtml);const out:any={};for(const[k,v]of Object.entries(obj))out[k]=(k==='htmlContent'||k==='passageHtml')&&typeof v==='string'?sanitizeHtmlServer(v):v&&typeof v==='object'?deepSanitizeHtml(v):v;return out;}

/** Authenticate admin/examiner with the same server-side session system as students. */
export function requireAdminAuth(req: AdminRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return res.status(403).json({error:'Forbidden.'});
  const session = authService.validateSession(header.slice('Bearer '.length).trim());
  if (!session || (session.role !== 'admin' && session.role !== 'examiner')) return res.status(403).json({error:'Forbidden.'});
  req.adminUser = { id:session.userId, username:session.username, displayName:session.name, role:session.role };
  return next();
}

const diskStorage = multer.diskStorage({
  destination: (_req,_file,cb)=>cb(null,UPLOADS_DIR),
  filename: (_req,file,cb)=>{const ext=path.extname(file.originalname).toLowerCase();const base=path.basename(file.originalname,ext).replace(/[^a-zA-Z0-9_-]/g,'_').slice(0,80)||'upload';cb(null,`${base}_${Date.now()}-${nanoid(8)}${ext}`);}
});
const fileFilter: multer.Options['fileFilter'] = (_req,file,cb)=>{const ext=path.extname(file.originalname).toLowerCase();cb(['.mp3','.wav','.ogg','.png','.jpg','.jpeg','.webp','.pdf','.docx','.txt','.html','.htm'].includes(ext)?null:new Error('Unsupported file type.'))};
const upload = multer({storage:diskStorage,fileFilter,limits:{fileSize:35*1024*1024,files:1,fields:20,fieldNameSize:100,fieldSize:256*1024,parts:22}});

adminRouter.post('/login', (req: Request,res:Response)=>{try{const result=authService.login(String(req.body?.username||''),String(req.body?.password||''));if(result.user.role!=='admin'&&result.user.role!=='examiner')return res.status(403).json({error:'Forbidden.'});return res.json({success:true,token:result.token,admin:{username:result.user.username,displayName:result.user.name,role:result.user.role}});}catch{return res.status(401).json({error:'Invalid credentials.'});}});
adminRouter.get('/me',requireAdminAuth,(req:AdminRequest,res)=>res.json({admin:req.adminUser}));
adminRouter.post('/logout',requireAdminAuth,(req:AdminRequest,res)=>{const h=req.headers.authorization;if(h?.startsWith('Bearer '))authService.logout(h.slice('Bearer '.length).trim());return res.json({success:true});});

adminRouter.get('/stats',requireAdminAuth,(_req,res)=>{try{return res.json({stats:adminStore.getStats()});}catch{return res.status(500).json({error:'Unable to load stats.'});}});

adminRouter.post('/upload',requireAdminAuth,upload.single('file'),async(req:AdminRequest,res)=>{const file=(req as any).file;if(!file)return res.status(400).json({error:'No file was uploaded.'});try{const ext=path.extname(file.originalname).toLowerCase();let extractedText='';let extractedHtml='';if(ext==='.html'||ext==='.htm'){const b=fs.readFileSync(file.path);const v=validateHtmlFileBuffer(b);if(!v.valid){try{fs.unlinkSync(file.path)}catch{};return res.status(400).json({error:v.error});}extractedHtml=sanitizeHtmlServer(b.toString('utf8'));fs.writeFileSync(file.path,extractedHtml,'utf8');extractedText=extractedHtml.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();}else if(ext==='.txt'){const b=fs.readFileSync(file.path);if(b.includes(0)){try{fs.unlinkSync(file.path)}catch{};return res.status(400).json({error:'Binary text file rejected.'});}extractedText=b.toString('utf8');}else if(ext==='.docx'){const r=await mammoth.extractRawText({path:file.path});extractedText=r.value||'';}else if(ext==='.pdf'){try{const mod=await import('pdf-parse');const fn=(mod as any).default||(mod as any).PDFParse||mod;if(typeof fn==='function'){const r=await fn(fs.readFileSync(file.path));extractedText=r.text||'';}}catch{}}
return res.json({success:true,file:{filename:file.filename,originalName:file.originalname,size:file.size,mimetype:file.mimetype,url:`/api/uploads/${file.filename}`,extractedHtml:extractedHtml||undefined,extractedText:extractedText.trim()||undefined}});}catch{try{fs.unlinkSync(file.path)}catch{};return res.status(500).json({error:'File upload failed.'});}});

adminRouter.get('/materials',requireAdminAuth,(req,res)=>{const status=['all','published','draft'].includes(String(req.query.status))?String(req.query.status) as any:undefined;const s=req.query.section;if(isSection(s))return res.json({items:adminStore.listMaterials(s,status)});return res.json({items:(['speaking','reading','listening','writing'] as const).flatMap(x=>adminStore.listMaterials(x,status))});});
adminRouter.get('/materials/:section/:id',requireAdminAuth,(req,res)=>{if(!isSection(req.params.section))return res.status(400).json({error:'Invalid section.'});const item=adminStore.getMaterial(req.params.section,req.params.id);return item?res.json({item}):res.status(404).json({error:'Material not found.'});});
adminRouter.post('/materials',requireAdminAuth,(req:AdminRequest,res)=>{if(!isSection(req.body?.section))return res.status(400).json({error:'Valid section is required.'});const body=deepSanitizeHtml(req.body);return res.json({success:true,item:adminStore.saveMaterial(req.body.section,body,req.adminUser?.displayName||'Admin')});});
adminRouter.post('/materials/:section',requireAdminAuth,(req:AdminRequest,res)=>{if(!isSection(req.params.section))return res.status(400).json({error:'Invalid section.'});return res.json({success:true,item:adminStore.saveMaterial(req.params.section,deepSanitizeHtml(req.body),req.adminUser?.displayName||'Admin')});});
adminRouter.put('/materials/:id',requireAdminAuth,(req:AdminRequest,res)=>{if(!isSection(req.body?.section))return res.status(400).json({error:'Valid section is required.'});return res.json({success:true,item:adminStore.saveMaterial(req.body.section,{...deepSanitizeHtml(req.body),id:req.params.id},req.adminUser?.displayName||'Admin')});});
adminRouter.put('/materials/:section/:id',requireAdminAuth,(req:AdminRequest,res)=>{if(!isSection(req.params.section))return res.status(400).json({error:'Invalid section.'});return res.json({success:true,item:adminStore.saveMaterial(req.params.section,{...deepSanitizeHtml(req.body),id:req.params.id},req.adminUser?.displayName||'Admin')});});
adminRouter.delete('/materials/:id',requireAdminAuth,(req,res)=>{for(const s of ['speaking','reading','listening','writing'] as const)if(adminStore.deleteMaterial(s,req.params.id))return res.json({success:true});return res.status(404).json({error:'Material not found.'});});
adminRouter.delete('/materials/:section/:id',requireAdminAuth,(req,res)=>{if(!isSection(req.params.section))return res.status(400).json({error:'Invalid section.'});return adminStore.deleteMaterial(req.params.section,req.params.id)?res.json({success:true}):res.status(404).json({error:'Material not found.'});});

adminRouter.get('/bundles',requireAdminAuth,(req,res)=>res.json({bundles:adminStore.listBundles(['all','published','draft'].includes(String(req.query.status))?String(req.query.status) as any:undefined)}));
adminRouter.get('/bundles/:id',requireAdminAuth,(req,res)=>{const x=adminStore.getResolvedBundle(req.params.id);return x?res.json(x):res.status(404).json({error:'CDI Bundle not found.'});});
adminRouter.post('/bundles',requireAdminAuth,(req,res)=>res.json({success:true,bundle:adminStore.saveBundle(deepSanitizeHtml(req.body))}));
adminRouter.put('/bundles/:id',requireAdminAuth,(req,res)=>res.json({success:true,bundle:adminStore.saveBundle({...deepSanitizeHtml(req.body),id:req.params.id})}));
adminRouter.delete('/bundles/:id',requireAdminAuth,(req,res)=>adminStore.deleteBundle(req.params.id)?res.json({success:true}):res.status(404).json({error:'Bundle not found.'}));

adminRouter.get('/public/materials/:section',(req,res)=>{if(!isSection(req.params.section))return res.status(400).json({error:'Invalid section.'});return res.json({items:adminStore.listMaterials(req.params.section,'published')});});
adminRouter.get('/public/bundles',(_req,res)=>res.json({bundles:adminStore.listBundles('published')}));
adminRouter.get('/public/bundles/:id',(req,res)=>{const x=adminStore.getResolvedBundle(req.params.id);return x&&x.bundle.status==='published'?res.json(x):res.status(404).json({error:'Published CDI exam not found.'});});
