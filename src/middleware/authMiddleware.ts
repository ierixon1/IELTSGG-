import { Request, Response, NextFunction } from 'express';
import { AsyncLocalStorage } from 'node:async_hooks';
import { authService, UserRole } from '../services/authService';
import { accountKey, admitRequest } from '../http/rateLimit';
import { clientAddressKey } from '../http/clientAddress';
import { explicitDevAuthEnabled } from '../config/devAuth';

export interface AuthenticatedRequest extends Request { userId?: string; userEmail?: string; userRole?: UserRole; userName?: string; }
export const requestContext = new AsyncLocalStorage<{ userId: string }>();
// Only with NODE_ENV explicitly development or test — never merely "not production" (M11, src/config/devAuth.ts).
const isExplicitDevAuthEnabled=explicitDevAuthEnabled;
const readCookie=(req:Request,name:string)=>{const header=req.headers.cookie||'';for(const part of header.split(';')){const [k,...v]=part.trim().split('=');if(k===name)return decodeURIComponent(v.join('='));}return '';};
export const AUTH_COOKIE='prep_auth';

/**
 * Signs a learner API request in, then counts it (H2).
 *
 * The account comes from the session cookie — or, only with EXPLICIT_DEV_AUTH
 * outside production, from an x-user-id header naming an existing account — and
 * the request is counted against that account's own allowance. A request without
 * a valid session is counted against its address and refused. So the other people
 * behind a learner's address, signed in or not, never spend that learner's
 * allowance, and anonymous traffic is still limited.
 */
export async function authenticateRequest(req:AuthenticatedRequest,res:Response,next:NextFunction){
 try{
  let userId:string|undefined,email:string|undefined,role:UserRole|undefined,name:string|undefined;
  let token='';
  // A cookie that is not valid percent-encoding is no credential: the request is anonymous.
  try{token=readCookie(req,AUTH_COOKIE);}catch(error){if(!(error instanceof URIError))throw error;}
  if(token){const session=await authService.validateSession(token);if(session){userId=session.userId;email=session.email;role=session.role;name=session.name;}}
  if(!userId&&isExplicitDevAuthEnabled()){
   const id=String(req.headers['x-user-id']||'').trim();
   if(/^[a-zA-Z0-9_\-.]{3,64}$/.test(id)){const user=await authService.getUserById(id);if(user){userId=user.id;email=user.email;role=user.role;name=user.name;}}
  }
  if(!userId){if(!await admitRequest(res,clientAddressKey(req),'api_anonymous'))return;return res.status(401).json({error:'Unauthorized.'});}
  if(!await admitRequest(res,accountKey(userId),'api_user'))return;
  req.userId=userId;req.userEmail=email;req.userRole=role||'student';req.userName=name;return requestContext.run({userId},next);
 }catch(error){
  // The rate limiter or the session store failing is the server's problem, not
  // the caller's credentials or pace, so the API error boundary answers it (503
  // when storage is unavailable) instead of a 401 or a 429.
  return next(error);
 }
}
export function requireRole(allowedRoles:UserRole[]){return(req:AuthenticatedRequest,res:Response,next:NextFunction)=>{if(!req.userId)return res.status(401).json({error:'Authentication required.'});if(!allowedRoles.includes(req.userRole||'student'))return res.status(403).json({error:'Forbidden.'});return next();};}
export function requireAuth(req:AuthenticatedRequest,res:Response,next:NextFunction){if(!req.userId)return res.status(401).json({error:'Authentication required.'});return next();}
