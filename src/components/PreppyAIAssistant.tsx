import React, { useState, useRef, useEffect } from 'react';
import { UserProfile } from '../types';
import { sendPreppyMessage } from '../services/api';
import { 
  Sparkles, 
  X, 
  Send, 
  Bot, 
  User, 
  HelpCircle, 
  BookOpen, 
  Zap,
  Lightbulb
} from 'lucide-react';

interface PreppyAIAssistantProps {
  isOpen: boolean;
  onClose: () => void;
  profile: UserProfile;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

export const PreppyAIAssistant: React.FC<PreppyAIAssistantProps> = ({
  isOpen,
  onClose,
  profile,
}) => {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 'm-1',
      role: 'assistant',
      content: `Hello! I am Preppy AI, your personal Academic IELTS mentor.
I see your current target is **Band ${profile.targetBand.toFixed(1)}**, focusing on **${profile.weakSection.toUpperCase()}**.
Ask me about essay structures, Band 8+ academic collocations, or test day timing strategies!`,
      timestamp: 'Just now',
    },
  ]);
  const [input, setInput] = useState<string>('');
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  if (!isOpen) return null;

  const handleSend = async (textToSend?: string) => {
    const text = textToSend || input;
    if (!text.trim() || isLoading) return;

    const userMsg: ChatMessage = {
      id: `u-${Date.now()}`,
      role: 'user',
      content: text,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };

    setMessages((prev) => [...prev, userMsg]);
    setInput('');
    setIsLoading(true);

    try {
      const history = [...messages, userMsg].map((m) => ({
        role: m.role,
        content: m.content,
      }));

      const reply = await sendPreppyMessage(history, {
        targetBand: profile.targetBand,
        weakSection: profile.weakSection,
      });

      const assistantMsg: ChatMessage = {
        id: `a-${Date.now()}`,
        role: 'assistant',
        content: reply,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      };
      setMessages((prev) => [...prev, assistantMsg]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          id: `err-${Date.now()}`,
          role: 'assistant',
          content: 'Sorry, I encountered a temporary connection glitch. Please check your query or try again.',
          timestamp: 'Just now',
        },
      ]);
    } finally {
      setIsLoading(false);
    }
  };

  const quickPrompts = [
    'How do I structure a Band 8 Task 2 essay?',
    '5 Band 8+ academic collocations for environmental topics',
    'How to eliminate long pauses in Speaking Part 2',
    'What is the difference between FALSE and NOT GIVEN?',
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-end bg-slate-900/40 backdrop-blur-xs p-2 sm:p-4">
      <div className="bg-white rounded-3xl w-full max-w-lg h-[90vh] shadow-2xl border border-slate-200 flex flex-col overflow-hidden animate-in slide-in-from-right duration-200">
        {/* Header */}
        <div className="p-4 sm:p-5 border-b border-slate-100 bg-slate-900 text-white flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 rounded-xl bg-indigo-600 flex items-center justify-center text-white shadow-md">
              <Sparkles className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center space-x-2">
                <h3 className="font-bold text-sm">Preppy AI Mentor</h3>
                <span className="text-[10px] font-semibold bg-indigo-500/30 text-indigo-200 px-2 py-0.5 rounded-full">
                  Examiner Logic
                </span>
              </div>
              <p className="text-xs text-slate-400">Target Band {profile.targetBand.toFixed(1)} Strategy</p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 text-slate-300 flex items-center justify-center transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Quick Prompts Bar */}
        <div className="p-3 bg-slate-50 border-b border-slate-100 overflow-x-auto flex items-center space-x-2 no-scrollbar">
          <span className="text-[10px] uppercase font-bold text-slate-400 shrink-0 flex items-center space-x-1">
            <Lightbulb className="w-3 h-3 text-amber-500" />
            <span>Suggested:</span>
          </span>
          {quickPrompts.map((prompt, i) => (
            <button
              key={i}
              onClick={() => handleSend(prompt)}
              className="text-[11px] font-medium text-slate-700 bg-white hover:bg-slate-100 px-2.5 py-1 rounded-full border border-slate-200 whitespace-nowrap shrink-0 transition-colors shadow-2xs"
            >
              {prompt}
            </button>
          ))}
        </div>

        {/* Message Thread */}
        <div className="flex-1 p-4 overflow-y-auto space-y-4 bg-white">
          {messages.map((m) => (
            <div
              key={m.id}
              className={`flex items-start space-x-2.5 ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              {m.role === 'assistant' && (
                <div className="w-7 h-7 rounded-lg bg-indigo-50 text-indigo-600 flex items-center justify-center shrink-0 mt-0.5 font-bold text-xs">
                  <Bot className="w-4 h-4" />
                </div>
              )}

              <div
                className={`p-3.5 rounded-2xl text-xs leading-relaxed max-w-[85%] whitespace-pre-wrap ${
                  m.role === 'user'
                    ? 'bg-slate-900 text-white rounded-br-xs'
                    : 'bg-slate-50 border border-slate-200 text-slate-800 rounded-bl-xs'
                }`}
              >
                {m.content}
                <div
                  className={`text-[9px] mt-1 text-right ${
                    m.role === 'user' ? 'text-slate-400' : 'text-slate-400'
                  }`}
                >
                  {m.timestamp}
                </div>
              </div>

              {m.role === 'user' && (
                <div className="w-7 h-7 rounded-lg bg-slate-200 text-slate-700 flex items-center justify-center shrink-0 mt-0.5 font-bold text-xs">
                  <User className="w-4 h-4" />
                </div>
              )}
            </div>
          ))}

          {isLoading && (
            <div className="flex items-center space-x-2 text-xs text-slate-400 p-2">
              <Sparkles className="w-4 h-4 animate-spin text-indigo-500" />
              <span>Preppy is consulting IELTS descriptors...</span>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Input Footer */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleSend();
          }}
          className="p-3 border-t border-slate-100 bg-slate-50 flex items-center space-x-2"
        >
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask Preppy about IELTS structure, timing, or criteria..."
            className="flex-1 px-4 py-2.5 rounded-xl border border-slate-200 text-xs text-slate-900 bg-white focus:outline-none focus:ring-2 focus:ring-slate-900"
          />
          <button
            type="submit"
            disabled={!input.trim() || isLoading}
            className="w-10 h-10 rounded-xl bg-slate-900 hover:bg-slate-800 disabled:bg-slate-300 text-white flex items-center justify-center transition-colors cursor-pointer shrink-0 shadow-sm"
          >
            <Send className="w-4 h-4" />
          </button>
        </form>
      </div>
    </div>
  );
};
