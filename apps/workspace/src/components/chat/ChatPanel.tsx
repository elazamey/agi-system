import React, { useRef, useEffect, useState } from 'react';
import type { Message} from '../../types';
import { SystemLevel } from '../../types';
import { ChatMessage } from './ChatMessage';
import { HoloOrb } from '../common/HoloOrb';
import { SYSTEM_LEVELS } from '../../data/mockData.ts';
import {
  Paperclip,
  Search,
  ShieldCheck,
  Send,
  Square,
  Trash2,
} from 'lucide-react';

interface ChatPanelProps {
  messages: Message[];
  isStreaming: boolean;
  streamingContent: string;
  streamingThought: string;
  systemLevel: string;
  language: 'ar' | 'en';
  onSendMessage: (text: string) => void;
  onStopStreaming: () => void;
  onClearHistory: () => void;
  onNavigateToTool: (toolName: string) => void;
}

export const ChatPanel: React.FC<ChatPanelProps> = ({
  messages,
  isStreaming,
  streamingContent,
  streamingThought,
  systemLevel,
  language,
  onSendMessage,
  onStopStreaming,
  onClearHistory,
  onNavigateToTool,
}) => {
  const isAr = language === 'ar';
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [inputValue, setInputValue] = useState('');
  const currentLevel = SYSTEM_LEVELS[systemLevel] || SYSTEM_LEVELS.L0;

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingContent]);

  const handleSubmit = () => {
    if (!inputValue.trim() || isStreaming) return;
    onSendMessage(inputValue);
    setInputValue('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="flex-1 flex flex-col h-full min-h-0">
      {/* Chat Header */}
      <div className="h-11 px-4 border-b border-white/[0.06] bg-[#080a12] flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <HoloOrb size="sm" isStreaming={isStreaming} />
          <div>
            <div className="text-xs font-semibold text-slate-200">
              {isAr ? 'وكيل AGI-OS الذكي' : 'AGI-OS Autonomous Agent'}
            </div>
            <div className="text-[9px] text-slate-500 font-mono">
              {isAr ? currentLevel.descriptionAr : currentLevel.descriptionEn}
            </div>
          </div>
        </div>
        <button
          onClick={onClearHistory}
          className="p-1.5 rounded-lg hover:bg-white/[0.06] text-slate-500 hover:text-red-400 transition-colors"
          title={isAr ? 'مسح السجل' : 'Clear History'}
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Messages Area */}
      <div className="flex-1 overflow-y-auto p-4 space-y-1 scrollbar-thin scrollbar-thumb-white/[0.08] scrollbar-track-transparent">
        {messages.map((msg) => (
          <ChatMessage
            key={msg.id}
            message={msg}
            language={language}
            onNavigateToTool={onNavigateToTool}
          />
        ))}

        {/* Streaming Message */}
        {isStreaming && (
          <div className="flex gap-3 mb-4">
            <div className="shrink-0 mt-1">
              <HoloOrb size="sm" isStreaming={true} />
            </div>
            <div className="flex flex-col items-start max-w-[80%]">
              {streamingThought && (
                <div className="mb-2 px-3 py-2 bg-cyan-500/10 border border-cyan-500/20 rounded-lg text-[10px] text-cyan-300/80 font-mono border-r-2 border-r-cyan-400 animate-pulse">
                  <div className="font-semibold text-cyan-400 mb-1">💭 Thinking...</div>
                  {streamingThought}
                </div>
              )}
              <div className="px-4 py-3 rounded-2xl rounded-tl-sm bg-[#111827] border border-white/[0.06] text-slate-200 text-sm leading-relaxed">
                {streamingContent}
                <span className="inline-block w-1.5 h-4 bg-cyan-400 ml-1 animate-pulse rounded-sm" />
              </div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input Area */}
      <div className="p-4 border-t border-white/[0.06] bg-[#080a12]">
        <div className="bg-[#111827] border border-white/[0.08] rounded-2xl p-3 focus-within:border-cyan-500/40 transition-colors">
          <textarea
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={isAr ? 'اكتب أمرك للوكيل الذكي...' : 'Type your command to the autonomous agent...'}
            className="w-full bg-transparent text-sm text-slate-200 placeholder-slate-600 resize-none outline-none min-h-[40px] max-h-[120px]"
            rows={1}
            disabled={isStreaming}
          />
          <div className="flex items-center justify-between mt-2 pt-2 border-t border-white/[0.04]">
            <div className="flex items-center gap-2 text-[9px] text-slate-600">
              <button className="flex items-center gap-1 hover:text-slate-400 transition-colors">
                <Paperclip className="w-3 h-3" />
                <span>{isAr ? 'إرفاق' : 'Attach'}</span>
              </button>
              <button className="flex items-center gap-1 hover:text-slate-400 transition-colors">
                <Search className="w-3 h-3" />
                <span>{isAr ? 'بحث' : 'Search'}</span>
              </button>
              <button className="flex items-center gap-1 hover:text-slate-400 transition-colors">
                <ShieldCheck className="w-3 h-3 text-emerald-500" />
                <span>{isAr ? 'حوكمة صارمة' : 'Strict Policy'}</span>
              </button>
            </div>
            <div className="flex items-center gap-2">
              {isStreaming ? (
                <button
                  onClick={onStopStreaming}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-red-500/20 hover:bg-red-500/30 border border-red-500/40 text-red-300 text-[11px] font-semibold transition-all"
                >
                  <Square className="w-3 h-3" />
                  {isAr ? 'إيقاف' : 'Stop'}
                </button>
              ) : (
                <button
                  onClick={handleSubmit}
                  disabled={!inputValue.trim()}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-500/40 text-cyan-300 text-[11px] font-semibold transition-all disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  <Send className="w-3 h-3" />
                  {isAr ? 'إرسال' : 'Send'}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
