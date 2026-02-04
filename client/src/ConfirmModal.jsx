import React from 'react';
import { motion } from 'framer-motion';
import { clsx } from 'clsx';
import { translations } from './i18n';

const ConfirmModal = ({ isOpen, title, message, onConfirm, onClose, lang = 'en', type = 'info' }) => {
    if (!isOpen) return null;
    const t = translations[lang];

    return (
        <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm" 
            onClick={onClose}
        >
            <motion.div 
                initial={{ opacity: 0, scale: 0.95, y: 10 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95, y: 10 }}
                transition={{ type: "spring", stiffness: 400, damping: 30 }}
                onClick={(e) => e.stopPropagation()}
                className="bg-white/90 backdrop-blur-2xl rounded-[32px] shadow-2xl w-full max-w-xs overflow-hidden border border-white/20 p-6 flex flex-col items-center gap-4 text-center"
            >
                <div className="space-y-2">
                    <h3 className="text-lg font-semibold text-slate-800">{title}</h3>
                    {message && <p className="text-sm text-slate-500 leading-relaxed px-2">{message}</p>}
                </div>

                <div className="grid grid-cols-2 gap-3 w-full mt-2">
                    <button 
                        onClick={onClose}
                        className="w-full py-3 bg-slate-100 text-slate-600 rounded-2xl font-medium hover:bg-slate-200 transition-colors text-sm"
                    >
                        {t.cancel}
                    </button>
                    <button 
                        onClick={() => { onConfirm(); onClose(); }}
                        className={clsx(
                            "w-full py-3 rounded-2xl font-medium text-white transition-colors text-sm shadow-lg shadow-indigo-200",
                            type === 'danger' ? "bg-red-500 hover:bg-red-600 shadow-red-200" : "bg-indigo-500 hover:bg-indigo-600"
                        )}
                    >
                       {type === 'danger' ? t.delete : t.close} 
                       {/* Note: Standardizing confirm button text might be needed, using dynamic prop if flexible */}
                    </button>
                </div>
            </motion.div>
        </motion.div>
    );
};

export default ConfirmModal;
