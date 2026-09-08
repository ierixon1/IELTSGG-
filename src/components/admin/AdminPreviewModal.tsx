import React from 'react';
import { X, Eye, BookOpen, Headphones, Edit3, Mic, CheckCircle2 } from 'lucide-react';
import { AdminMaterial, FullCdiBundle } from '../../types/admin';

interface AdminPreviewModalProps {
  material?: AdminMaterial | null;
  bundle?: { bundle: FullCdiBundle; resolvedMaterials: any } | null;
  onClose: () => void;
}

export const AdminPreviewModal: React.FC<AdminPreviewModalProps> = ({
  material,
  bundle,
  onClose,
}) => {
  if (!material && !bundle) return null;

  return (
    <div className="fixed inset-0 z-50 bg-ink-900/60 backdrop-blur-xs flex items-center justify-center p-4 overflow-y-auto">
      <div className="bg-white border border-ink-200 rounded-2xl max-w-3xl w-full max-h-[90vh] flex flex-col shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-ink-200 bg-ink-50">
          <div className="flex items-center space-x-2">
            <Eye className="w-4 h-4 text-brand-600" />
            <span className="text-sm font-bold text-ink-900">
              Student Candidate View Preview
            </span>
            <span className="text-xs bg-brand-100 text-brand-800 px-2 py-0.5 rounded-full font-semibold">
              Live Preview
            </span>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-ink-400 hover:text-ink-700 rounded-lg hover:bg-ink-200/50"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {material && (
            <div className="space-y-4">
              <div className="border-b border-ink-100 pb-3">
                <span className="text-[10px] font-bold uppercase tracking-wider text-ink-400">
                  {material.section.toUpperCase()} • {material.module.toUpperCase()} MODULE
                </span>
                <h3 className="text-xl font-bold text-ink-900">{material.title}</h3>
                <div className="flex items-center space-x-2 mt-1">
                  <span className="text-xs text-ink-500">Benchmark Target: Band {material.targetBand || '7.5'}</span>
                  <span className="text-ink-300">•</span>
                  <span className="text-xs text-ink-500">Status: {material.status}</span>
                </div>
              </div>

              {/* Speaking Preview */}
              {material.section === 'speaking' && (
                <div className="space-y-4">
                  <div className="p-4 bg-ink-50 rounded-xl border border-ink-200">
                    <span className="text-xs font-bold text-brand-700 uppercase block mb-1">
                      Part 1: {material.content.speakingSession.part1.topic}
                    </span>
                    <ul className="space-y-1.5 text-xs text-ink-700 list-disc list-inside">
                      {material.content.speakingSession.part1.questions.map((q, i) => (
                        <li key={i}>{q}</li>
                      ))}
                    </ul>
                  </div>

                  <div className="p-4 bg-warning-50 rounded-xl border border-warning-50">
                    <span className="text-xs font-bold text-warning-700 uppercase block mb-1">
                      Part 2 Cue Card:
                    </span>
                    <h4 className="text-sm font-bold text-ink-900 mb-2">
                      {material.content.speakingSession.part2.cueCardTopic}
                    </h4>
                    <ul className="space-y-1 text-xs text-ink-700 list-disc list-inside">
                      {material.content.speakingSession.part2.bulletPoints.map((b, i) => (
                        <li key={i}>{b}</li>
                      ))}
                    </ul>
                  </div>

                  <div className="p-4 bg-ink-50 rounded-xl border border-ink-200">
                    <span className="text-xs font-bold text-brand-700 uppercase block mb-1">
                      Part 3 Discussion:
                    </span>
                    <ul className="space-y-1.5 text-xs text-ink-700 list-disc list-inside">
                      {material.content.speakingSession.part3.questions.map((q, i) => (
                        <li key={i}>{q}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              )}

              {/* Reading Preview */}
              {material.section === 'reading' && (
                <div className="space-y-4">
                  <div className="p-5 bg-white rounded-xl border border-ink-200 shadow-2xs">
                    <h4 className="text-base font-bold text-ink-900 mb-2 font-serif">
                      {material.content.passage.title}
                    </h4>
                    <p className="text-xs leading-relaxed text-ink-700 font-serif whitespace-pre-line">
                      {material.content.passage.text}
                    </p>
                  </div>

                  <div className="space-y-3">
                    <span className="text-xs font-bold text-ink-800 uppercase tracking-wider block">
                      Candidate Questions ({material.content.passage.questions.length})
                    </span>
                    {material.content.passage.questions.map((q, i) => (
                      <div key={i} className="p-3 bg-ink-50 rounded-lg border border-ink-200 text-xs space-y-1.5">
                        <div className="font-semibold text-ink-900">
                          {i + 1}. {q.questionText}
                        </div>
                        {q.options && (
                          <div className="grid grid-cols-2 gap-1 text-[11px] text-ink-600 pl-4">
                            {q.options.map((opt, oi) => (
                              <div key={oi}>• {opt}</div>
                            ))}
                          </div>
                        )}
                        <div className="text-[11px] text-success-700 font-bold bg-success-50 px-2 py-0.5 rounded inline-block">
                          Verified Key: {q.correctAnswer}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Listening Preview */}
              {material.section === 'listening' && (
                <div className="space-y-4">
                  {material.content.audioUrl && (
                    <div className="p-4 bg-brand-50 border border-brand-200 rounded-xl flex items-center justify-between">
                      <div className="flex items-center space-x-2">
                        <Headphones className="w-5 h-5 text-brand-600" />
                        <span className="text-xs font-bold text-brand-900">Audio Track Player</span>
                      </div>
                      <audio controls src={material.content.audioUrl} className="h-8 max-w-sm" />
                    </div>
                  )}

                  <div className="p-4 bg-ink-50 rounded-xl border border-ink-200">
                    <h4 className="text-xs font-bold text-ink-900 mb-1">{material.content.section.title}</h4>
                    <p className="text-xs text-ink-600">{material.content.section.contextDescription}</p>
                  </div>

                  <div className="space-y-2">
                    <span className="text-xs font-bold text-ink-800 uppercase tracking-wider block">
                      Questions ({material.content.section.questions.length})
                    </span>
                    {material.content.section.questions.map((q, i) => (
                      <div key={i} className="p-3 bg-white rounded-lg border border-ink-200 text-xs space-y-1">
                        <div className="font-semibold text-ink-900">{i + 1}. {q.questionText}</div>
                        <div className="text-[11px] text-success-700 font-bold">Answer: {q.correctAnswer}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Writing Preview */}
              {material.section === 'writing' && (
                <div className="space-y-4">
                  <div className="p-4 bg-ink-50 rounded-xl border border-ink-200 space-y-2">
                    <span className="text-xs font-bold text-ink-900 uppercase">
                      {material.content.task.task1?.taskType || 'Task 1'} (150 words)
                    </span>
                    {material.content.task1ImageUrl && (
                      <img
                        src={material.content.task1ImageUrl}
                        alt="Task 1 diagram"
                        className="max-h-48 rounded-lg border border-ink-200 mx-auto"
                      />
                    )}
                    <p className="text-xs text-ink-700 leading-relaxed">
                      {material.content.task.task1?.prompt}
                    </p>
                  </div>

                  <div className="p-4 bg-ink-50 rounded-xl border border-ink-200 space-y-2">
                    <span className="text-xs font-bold text-ink-900 uppercase">
                      Task 2 Essay (250 words)
                    </span>
                    <p className="text-xs text-ink-700 leading-relaxed font-medium">
                      {material.content.task.task2?.prompt}
                    </p>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Bundle Preview */}
          {bundle && (
            <div className="space-y-4">
              <div className="border-b border-ink-100 pb-3">
                <span className="text-[10px] font-bold uppercase tracking-wider text-brand-600">
                  FULL CDI TEST EXAM
                </span>
                <h3 className="text-xl font-bold text-ink-900">{bundle.bundle.title}</h3>
                <p className="text-xs text-ink-500 mt-1">{bundle.bundle.description}</p>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-center">
                <div className="p-3 bg-brand-50 border border-brand-200 rounded-xl">
                  <div className="text-[10px] font-bold text-brand-700 uppercase">Listening</div>
                  <div className="text-xs font-extrabold text-ink-900">{bundle.bundle.timings.listeningMinutes} min</div>
                  <div className="text-[10px] text-ink-500 truncate mt-1">
                    {bundle.resolvedMaterials.listening?.title || 'Default Track'}
                  </div>
                </div>

                <div className="p-3 bg-success-50 border border-success-50 rounded-xl">
                  <div className="text-[10px] font-bold text-success-700 uppercase">Reading</div>
                  <div className="text-xs font-extrabold text-ink-900">{bundle.bundle.timings.readingMinutes} min</div>
                  <div className="text-[10px] text-ink-500 truncate mt-1">
                    {bundle.resolvedMaterials.reading?.title || 'Default Passage'}
                  </div>
                </div>

                <div className="p-3 bg-warning-50 border border-warning-50 rounded-xl">
                  <div className="text-[10px] font-bold text-warning-700 uppercase">Writing</div>
                  <div className="text-xs font-extrabold text-ink-900">{bundle.bundle.timings.writingMinutes} min</div>
                  <div className="text-[10px] text-ink-500 truncate mt-1">
                    {bundle.resolvedMaterials.writing?.title || 'Default Tasks'}
                  </div>
                </div>

                <div className="p-3 bg-danger-50 border border-danger-50 rounded-xl">
                  <div className="text-[10px] font-bold text-danger-700 uppercase">Speaking</div>
                  <div className="text-xs font-extrabold text-ink-900">{bundle.bundle.timings.speakingMinutes} min</div>
                  <div className="text-[10px] text-ink-500 truncate mt-1">
                    {bundle.resolvedMaterials.speaking?.title || 'Default Interview'}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-ink-200 bg-ink-50 flex items-center justify-end">
          <button
            onClick={onClose}
            className="px-4 py-1.5 text-xs font-bold bg-ink-900 text-white rounded-lg"
          >
            Close Preview
          </button>
        </div>
      </div>
    </div>
  );
};
