import { GoogleGenAI } from '@google/genai';
import { GenerateMockRequest, GeneratedMockResult } from '../types';
import { generateListening } from '../../prompts/generateListening';
import { generateReading } from '../../prompts/generateReading';
import { generateSpeaking } from '../../prompts/generateSpeaking';
import { generateWriting } from '../../prompts/generateWriting';
import { requestContext } from '../middleware/authMiddleware';
import { aiRateLimitService } from './aiRateLimitService';
import { dataStore } from './storage';
import { AI_OPERATION_LIMITS } from './aiRateLimitService';

export class MockGeneratorService {
  private getAI(){const key=process.env.GEMINI_API_KEY;if(!key)throw new Error('AI service is not configured.');return new GoogleGenAI({apiKey:key});}
  async generateMock(req:GenerateMockRequest,recentThemes:string[]=[]):Promise<GeneratedMockResult>{
    const userId=requestContext.getStore()?.userId;
    const maxGenerations=Number.parseInt(process.env.RATE_LIMIT_GENERATIONS||'10',10)||AI_OPERATION_LIMITS.mock_generation.daily;
    if(userId){const reserved=await dataStore.reserveGeneration(userId,maxGenerations);if(!reserved)throw new Error(`Daily generation limit reached (${maxGenerations}).`);const aiGuard=await aiRateLimitService.checkLimit(userId,'mock_generation');if(!aiGuard.allowed)throw new Error(aiGuard.reason);}
    const ai=this.getAI(); const theme=req.theme||'Education and society'; const avoid=recentThemes.filter(Boolean).slice(0,10).join(', ');
    const context={ai,theme,avoidThemes:avoid,targetBand:req.targetBand,module:req.module,section:req.section}; let testData:any;
    if(req.section==='listening')testData=await generateListening(context as any); else if(req.section==='reading')testData=await generateReading(context as any); else if(req.section==='writing')testData=await generateWriting(context as any); else testData=await generateSpeaking(context as any);
    const id=`mock_${Date.now()}_${Math.random().toString(36).slice(2,8)}`,contentHash=JSON.stringify(testData).slice(0,200);
    return {id,module:req.module,section:req.section,targetBand:req.targetBand,theme,title:`IELTS ${req.section} mock — ${theme}`,questionTypes:[],contentHash,testData};
  }
}
export const mockGeneratorService=new MockGeneratorService();
