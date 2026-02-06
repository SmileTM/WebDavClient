import React from 'react';
import { motion } from 'framer-motion';
import { XMarkIcon, DocumentIcon, FolderIcon } from '@heroicons/react/24/outline';
import { translations } from './i18n';

const formatSize = (bytes) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

const DetailsModal = ({ file, driveName, onClose, lang = 'zh' }) => {
    const t = translations[lang];

    const isFolder = file.isDirectory;
    const sizeDisplay = isFolder 
        ? (file.itemCount !== undefined ? t.items.replace('{count}', file.itemCount) : '-')
        : formatSize(file.size);
    
    // Format Date
    const dateDisplay = new Date(file.mtime).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });

    return (
        <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm" 
            onClick={onClose}
        >
            <motion.div 
                initial={{ opacity: 0, scale: 0.95, y: 10 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95, y: 10 }}
                transition={{ type: "spring", stiffness: 400, damping: 30 }}
                onClick={(e) => e.stopPropagation()}
                className="bg-white/90 backdrop-blur-2xl rounded-[32px] shadow-2xl w-full max-w-sm overflow-hidden border border-white/20 p-6 flex flex-col gap-4"
            >
                <div className="text-center">
                    <h3 className="text-lg font-semibold text-slate-800">{t.fileInfo}</h3>
                </div>

                <div className="flex flex-col items-center">
                    <div className="w-16 h-16 bg-white/50 rounded-2xl flex items-center justify-center mb-3 shadow-sm border border-white/20 text-indigo-500">
                        {isFolder ? <FolderIcon className="w-8 h-8" /> : <DocumentIcon className="w-8 h-8" />}
                    </div>
                    <h2 className="text-base font-medium text-slate-800 text-center break-all px-2 line-clamp-2">{file.name}</h2>
                    <p className="text-xs text-slate-400 mt-1">{isFolder ? t.folder : t.file}</p>
                </div>

                <div className="space-y-3 w-full bg-slate-50/50 rounded-2xl p-4 border border-white/10">
                    <div className="flex justify-between items-center text-xs">
                        <span className="text-slate-400">{t.type}</span>
                        <span className="text-slate-700 font-medium truncate max-w-[70%]">
                            {isFolder ? t.folder : (file.name.includes('.') ? file.name.split('.').pop().toUpperCase() : (file.type || 'Unknown'))}
                        </span>
                    </div>
                    
                    <div className="flex justify-between items-center text-xs">
                        <span className="text-slate-400">{t.location}</span>
                        <span className="text-slate-700 font-medium truncate max-w-[70%]" title={file.path}>{file.path}</span>
                    </div>

                    <div className="flex justify-between items-center text-xs">
                        <span className="text-slate-400">{t.size}</span>
                        <span className="text-slate-700 font-medium truncate max-w-[70%]">{sizeDisplay}</span>
                    </div>

                    <div className="flex justify-between items-center text-xs">
                        <span className="text-slate-400">{t.modified}</span>
                        <span className="text-slate-700 font-medium truncate max-w-[70%]">{dateDisplay}</span>
                    </div>
                </div>

                <button 
                    onClick={onClose}
                    className="w-full py-3 bg-indigo-500 text-white rounded-2xl font-medium hover:bg-indigo-600 transition-all text-sm shadow-lg shadow-indigo-200 mt-2"
                >
                    {t.close}
                </button>
            </motion.div>
        </motion.div>
    );
};

export default DetailsModal;
