import { Request, Response, NextFunction } from 'express';
import { AsyncLocalStorage } from 'node:async_hooks';
import { authService, UserRole } from '../services/authService';
import { requestRateLimitService } from '../services/requestRateLimitService';

export interface AuthenticatedRequest extends Request { userId?: string; userEmail?: string; userRole?: UserRole; userName?: string; }
export const requestContext = new AsyncLocalStorage<{ userId: string }>();
const isExplicitDevAuthEnabled=()=>process.env.NODE_ENV!=='production'&&process.env.EXPLICIT_DEV_AUTH==='true';
const readCookie=(req:Request,name:string)=>{const header=req.headers.cookie||'';for(const part of header.split(';')){const [k,...v]=part.trim().split('=');if(k===name)return decodeURIComponent(v.join('='));}return '';};
export const AUTH_COOKIE='prep_auth';

export async function authenticateRequest(req:AuthenticatedRequest,res:Response,next:NextFunction){
 try{
  const ip=String(req.ip||req.socket.remoteAddress||'unknown');
  const limiter=await requestRateLimitService.check(`api:${ip}`,'api_global');
  if(!limiter.allowed){res.setHeader('Retry-After',String(Math.max(1,Math.ceil(limiter.retryAfterMs/1000))));return res.status(429).json({error:'Too many requests. Please try again later.'});}
  let userId:string|undefined,email:string|undefined,role:UserRole|undefined,name:string|undefined;
  const token=readCookie(req,AUTH_COOKIE);
  if(token){const session=await authService.validateSession(token);if(session){userId=session.userId;email=session.email;role=session.role;name=session.name;}}
  if(!userId&&isExplicitDevAuthEnabled()){
   const id=String(req.headers['x-user-id']||'').trim();
   if(/^[a-zA-Z0-9_\-.]{3,64}$/.test(id)){const user=await authService.getUserById(id);if(user){userId=user.id;email=user.email;role=user.role;name=user.name;}}
  }
  if(!userId)return res.status(401).json({error:'Unauthorized.'});
  req.userId=userId;req.userEmail=email;req.userRole=role||'student';req.userName=name;return requestContext.run({userId},next);
 }catch(error){
  // A cookie that is not valid percent-encoding is a bad credential, not a server fault.
  if(error instanceof URIError)return res.status(401).json({error:'Unauthorized.'});
  // Anything else is the rate limiter or the session store failing. That is the
  // server's problem, not the caller's credentials, so the API error boundary
  // answers it (503 when storage is unavailable) instead of a 401.
  return next(error);
 }
}
export function requireRole(allowedRoles:UserRole[]){return(req:AuthenticatedRequest,res:Response,next:NextFunction)=>{if(!req.userId)return res.status(401).json({error:'Authentication required.'});if(!allowedRoles.includes(req.userRole||'student'))return res.status(403).json({error:'Forbidden.'});return next();};}
export function requireAuth(req:AuthenticatedRequest,res:Response,next:NextFunction){if(!req.userId)return res.status(401).json({error:'Authentication required.'});return next();}
