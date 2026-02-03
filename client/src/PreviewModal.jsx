import React, { useState, useEffect } from 'react';
import { XMarkIcon, ArrowDownTrayIcon, DocumentIcon, ChevronLeftIcon, ChevronRightIcon } from '@heroicons/react/24/outline';
import heic2any from 'heic2any';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';
import api from './api';

// Configure PDF Worker
// Standard way for Vite: use import meta url or CDN
// Using CDN for simplicity and reliability in diverse build environments
pdfjs.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

const PreviewModal = ({ file, onClose, drive = 'local' }) => {
  const [content, setContent] = useState(null);
  const [loading, setLoading] = useState(false);
  const [url, setUrl] = useState('');
  
  // PDF State
  const [numPages, setNumPages] = useState(null);
  const [pdfScale, setPdfScale] = useState(1.0);

  const fileType = file.type || '';
  const isHeic = fileType === 'image/heic' || fileType === 'image/heif' || /\.(heic|heif)$/i.test(file.name);
  const isImage = (fileType.startsWith('image/') || /\.(jpg|jpeg|png|gif|webp|svg|bmp)$/i.test(file.name)) && !isHeic;
  const isVideo = fileType.startsWith('video/') || /\.(mp4|webm|ogg|mov|avi|mkv|3gp)$/i.test(file.name);
  const isAudio = fileType.startsWith('audio/') || /\.(mp3|wav|aac|flac|m4a)$/i.test(file.name);
  const isPDF = fileType === 'application/pdf' || /\.pdf$/i.test(file.name);
  const isText = fileType.startsWith('text/') || 
                 /\.(json|js|jsx|ts|tsx|py|md|css|html|xml|yml|yaml|ini|conf|sh|bash|zsh)$/i.test(file.name);

  useEffect(() => {
    const load = async () => {
        if (isHeic) {
            setLoading(true);
            try {
                // For HEIC, we need the actual blob to convert
                const blob = await api.getFileBlob(file.path, drive);
                const convertedBlob = await heic2any({
                    blob,
                    toType: "image/jpeg",
                    quality: 0.8
                });
                // Handle case where heic2any returns an array
                const resultBlob = Array.isArray(convertedBlob) ? convertedBlob[0] : convertedBlob;
                setUrl(URL.createObjectURL(resultBlob));
            } catch (e) {
                console.error("HEIC conversion failed", e);
                // Fallback to raw URL if conversion fails
                const res = await api.getFileUrl(file.path, drive);
                setUrl(res);
            } finally {
                setLoading(false);
            }
            return;
        }

        const res = await api.getFileUrl(file.path, drive);
        setUrl(res);
        
        if (isText) {
            setLoading(true);
            try {
                const text = await api.readFileText(file.path, drive);
                setContent(text);
            } catch (e) {
                setContent('Error loading content');
            } finally {
                setLoading(false);
            }
        }
    };
    load();

    return () => {
        if (isHeic && url) {
            URL.revokeObjectURL(url);
        }
    }
  }, [file.path, drive, isText, isHeic]);

  // Handle Hardware Back Button (Android) and ESC key
  useEffect(() => {
    const handleEsc = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleEsc);
    
    return () => {
        window.removeEventListener('keydown', handleEsc);
    };
  }, [onClose]);

  function onDocumentLoadSuccess({ numPages }) {
    setNumPages(numPages);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 backdrop-blur-sm p-4" onClick={onClose}>
      
      {/* Main Content Area */}
      <div 
        className="relative max-w-5xl max-h-[85vh] w-full flex flex-col items-center justify-center pb-16"
        onClick={e => e.stopPropagation()} // Prevent closing when clicking content
      >
        
        {/* Preview Renderers */}
        {(isImage || isHeic) && url && (
          <img src={url} alt={file.name} className="max-w-full max-h-[80vh] object-contain rounded-lg shadow-2xl" />
        )}

        {isVideo && url && (
          <video src={url} controls autoPlay className="max-w-full max-h-[80vh] rounded-lg shadow-2xl bg-black" />
        )}

        {isAudio && url && (
          <div className="bg-white p-8 rounded-2xl shadow-2xl flex flex-col items-center gap-4 min-w-[300px]">
            <div className="w-24 h-24 bg-indigo-100 rounded-full flex items-center justify-center mb-2">
              <DocumentIcon className="w-12 h-12 text-indigo-500" />
            </div>
            <h3 className="font-medium text-slate-800 text-center truncate w-full px-2">{file.name}</h3>
            <audio src={url} controls className="w-full" autoPlay />
          </div>
        )}

        {isPDF && url && (
          <div className="relative w-full h-[80vh] bg-slate-100 rounded-lg shadow-2xl overflow-hidden flex flex-col items-center">
            <div className="flex-1 overflow-auto w-full flex flex-col items-center p-4">
               <Document
                  file={url}
                  onLoadSuccess={onDocumentLoadSuccess}
                  loading={<div className="text-slate-500 mt-10">Loading PDF...</div>}
                  error={<div className="text-red-500 mt-10">Failed to load PDF.</div>}
                  className="shadow-lg flex flex-col gap-4"
                >
                  {Array.from(new Array(numPages), (el, index) => (
                    <Page 
                      key={`page_${index + 1}`}
                      pageNumber={index + 1} 
                      scale={pdfScale}
                      width={window.innerWidth > 800 ? 800 : window.innerWidth - 60}
                      renderTextLayer={false} 
                      renderAnnotationLayer={false}
                      className="bg-white shadow-sm"
                    />
                  ))}
                </Document>
            </div>
          </div>
        )}

        {isText && (
          <div className="w-full h-[80vh] bg-white rounded-lg shadow-2xl overflow-auto p-4 font-mono text-sm text-slate-700 whitespace-pre-wrap">
            {loading ? 'Loading...' : content}
          </div>
        )}

        {/* Fallback for unsupported types */}
        {!isImage && !isHeic && !isVideo && !isAudio && !isPDF && !isText && (
          <div className="bg-white p-10 rounded-2xl shadow-2xl flex flex-col items-center gap-6">
            <DocumentIcon className="w-20 h-20 text-slate-300" />
            <div className="text-center">
              <p className="text-lg font-medium text-slate-700">No Preview Available</p>
              <p className="text-sm text-slate-400 mt-1">{file.name}</p>
            </div>
            {url && (
            <a 
              href={url} 
              download={file.name}
              className="flex items-center gap-2 bg-indigo-600 text-white px-6 py-2.5 rounded-full hover:bg-indigo-700 transition-colors font-medium"
            >
              <ArrowDownTrayIcon className="w-5 h-5" />
              Download File
            </a>
            )}
          </div>
        )}
      </div>

      {/* Unified Bottom Controls - Centered for Mobile Ergonomics */}
      <div 
        className="fixed left-1/2 -translate-x-1/2 flex items-center gap-6 z-50 px-6 py-3 rounded-full bg-white/10 backdrop-blur-md border border-white/10 shadow-2xl"
        style={{ bottom: 'calc(2rem + env(safe-area-inset-bottom))' }}
      >
        {/* Close Button */}
        <button 
          onClick={onClose}
          className="flex items-center justify-center p-3 bg-white/10 hover:bg-white/20 rounded-full text-white transition-all active:scale-95"
          title="Close"
        >
          <XMarkIcon className="w-6 h-6" />
        </button>

        {/* Divider */}
        <div className="w-px h-6 bg-white/20" />

        {/* Download Button */}
        {url && (
          <a 
            href={url} 
            download={file.name}
            onClick={(e) => e.stopPropagation()}
            className="flex items-center justify-center p-3 bg-white/10 hover:bg-white/20 rounded-full text-white transition-all active:scale-95"
            title="Download"
          >
            <ArrowDownTrayIcon className="w-6 h-6" />
          </a>
        )}
      </div>

    </div>
  );
};

export default PreviewModal;