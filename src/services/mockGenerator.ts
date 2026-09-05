import { GoogleGenAI } from '@google/genai';
import { GenerateMockRequest, GeneratedMockResult } from '../types';
import { generateListening } from '../../prompts/generateListening';
import { generateReading } from '../../prompts/generateReading';
import { generateSpeaking } from '../../prompts/generateSpeaking';
import { generateWriting } from '../../prompts/generateWriting';

export class MockGeneratorService {
  private getAI(){const key=process.env.GEMINI_API_KEY;if(!key)throw new Error('AI service is not configured.');return new GoogleGenAI({apiKey:key});}
  async generateMock(req:GenerateMockRequest,recentThemes:string[]=[]):Promise<GeneratedMockResult>{
    const ai=this.getAI(); const theme=req.theme||'Education and society'; const avoid=recentThemes.filter(Boolean).slice(0,10).join(', ');
    const context={ai,theme,avoidThemes:avoid,targetBand:req.targetBand,module:req.module,section:req.section}; let testData:any;
    if(req.section==='listening')testData=await generateListening(context as any); else if(req.section==='reading')testData=await generateReading(context as any); else if(req.section==='writing')testData=await generateWriting(context as any); else testData=await generateSpeaking(context as any);
    const id=`mock_${Date.now()}_${Math.random().toString(36).slice(2,8)}`,contentHash=JSON.stringify(testData).slice(0,200);
    return {id,module:req.module,section:req.section,targetBand:req.targetBand,theme,title:`IELTS ${req.section} mock — ${theme}`,questionTypes:[],contentHash,testData};
  }
}
export const mockGeneratorService=new MockGeneratorService();
