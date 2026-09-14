import sanitizeHtml from 'sanitize-html';
import { namespaceCdiId } from '../utils/cdiIds';

/**
 * The server's HTML sanitiser, and the material fields it is applied to.
 *
 * Moved out of `adminRoutes.ts` (which re-exports it) so the material store can
 * apply it on every write, whichever route or pipeline wrote the material (M5).
 */

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

const MARKUP_KEYS = new Set(['htmlContent', 'passageHtml']);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** A copy of `value` with every `htmlContent` and `passageHtml` string, at any depth, sanitised. */
export function deepSanitizeHtml<T>(value: T): T {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!isRecord(node)) return node;
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(node)) out[key] = MARKUP_KEYS.has(key) && typeof child === 'string' ? sanitizeHtmlServer(child) : walk(child);
    return out;
  };
  return walk(value) as T;
}

/** Whether a string holds a tag: the learner screens render such text as HTML. */
const LOOKS_LIKE_MARKUP = /<[a-z!/?][\s\S]*>/i;

/**
 * A material with every field a learner screen renders as HTML sanitised (M5).
 *
 * - every `htmlContent` / `passageHtml`, at any depth;
 * - a Reading passage's `text`, which the Reading screen renders through the HTML
 *   viewer, when it holds markup;
 * - a Writing task's `prompt`, which the Writing screen renders as HTML when it
 *   holds a tag.
 *
 * Plain text — no tag — is left exactly as written, so passages and prompts keep
 * their characters (a Book → Test passage must stay verbatim to its source), and
 * the client's DOMPurify renders it safely. Sanitising is idempotent, so a save
 * that changes nothing still changes nothing.
 */
export function sanitizeRenderedMaterialHtml(section: string, material: Record<string, unknown>): Record<string, unknown> {
  const sanitized = deepSanitizeHtml(material);
  const content = sanitized.content;
  if (!isRecord(content)) return sanitized;
  const markupOnly = (text: unknown) => (typeof text === 'string' && LOOKS_LIKE_MARKUP.test(text) ? sanitizeHtmlServer(text) : text);
  if (section === 'reading' && isRecord(content.passage)) {
    content.passage = { ...content.passage, text: markupOnly(content.passage.text) };
  }
  if (section === 'writing' && isRecord(content.task)) {
    const task: Record<string, unknown> = { ...content.task };
    for (const key of ['task1', 'task2']) {
      const entry = task[key];
      if (isRecord(entry) && entry.prompt !== undefined) task[key] = { ...entry, prompt: markupOnly(entry.prompt) };
    }
    content.task = task;
  }
  return sanitized;
}
