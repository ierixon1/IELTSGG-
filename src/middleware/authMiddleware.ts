import { Request, Response, NextFunction } from 'express';
import { AsyncLocalStorage } from 'node:async_hooks';
import { authService, UserRole } from '../services/authService';

export interface AuthenticatedRequest extends Request { userId?: string; userEmail?: string; userRole?: UserRole; userName?: string; }
export const requestContext = new AsyncLocalStorage<{ userId: string }>();
const isExplicitDevAuthEnabled=()=>process.env.NODE_ENV!=='production'&&process.env.EXPLICIT_DEV_AUTH==='true';

export async function authenticateRequest(req:AuthenticatedRequest,res:Response,next:NextFunction){
 try{
  const header=req.headers.authorization;let userId:string|undefined,email:string|undefined,role:UserRole|undefined,name:string|undefined;
  if(header?.startsWith('Bearer ')){
   const token=header.slice(7).trim();
   if(token){const session=await authService.validateSession(token);if(session){userId=session.userId;email=session.email;role=session.role;name=session.name;}}
  }
  if(!userId&&isExplicitDevAuthEnabled()){
   const id=String(req.headers['x-user-id']||'').trim();
   if(/^[a-zA-Z0-9_\-.]{3,64}$/.test(id)){const user=await authService.getUserById(id);if(user){userId=user.id;email=user.email;role=user.role;name=user.name;}}
  }
  if(!userId)return res.status(401).json({error:'Unauthorized.'});
  req.userId=userId;req.userEmail=email;req.userRole=role||'student';req.userName=name;return requestContext.run({userId},next);
 }catch(error:any){console.error('[AuthMiddleware] Verification error:',error?.message||'unknown error');return res.status(401).json({error:'Unauthorized.'});}
}
export function requireRole(allowedRoles:UserRole[]){return(req:AuthenticatedRequest,res:Response,next:NextFunction)=>{if(!req.userId)return res.status(401).json({error:'Authentication required.'});if(!allowedRoles.includes(req.userRole||'student'))return res.status(403).json({error:'Forbidden.'});return next();};}
export function requireAuth(req:AuthenticatedRequest,res:Response,next:NextFunction){if(!req.userId)return res.status(401).json({error:'Authentication required.'});return next();}
