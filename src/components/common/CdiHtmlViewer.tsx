import React, { useMemo } from 'react';
import { sanitizeClientHtml } from '../../utils/sanitizeHtml';

interface CdiHtmlViewerProps {
  html: string;
  className?: string;
  id?: string;
}

/**
 * CdiHtmlViewer renders sanitized HTML content inside the CDI test simulation.
 * It applies authentic IELTS computer-delivered test typography, table styling,
 * margins, and readability rules.
 */
export const CdiHtmlViewer: React.FC<CdiHtmlViewerProps> = ({
  html,
  className = '',
  id,
}) => {
  const safeHtml = useMemo(() => {
    return sanitizeClientHtml(html);
  }, [html]);

  if (!safeHtml) return null;

  return (
    <div
      id={id || 'cdi-html-viewer'}
      className={`cdi-html-content prose prose-slate max-w-none text-slate-800 leading-relaxed font-sans text-sm md:text-base selection:bg-amber-100 ${className}`}
      dangerouslySetInnerHTML={{ __html: safeHtml }}
    />
  );
};
