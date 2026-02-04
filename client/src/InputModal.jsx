import React, { useState, useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { XMarkIcon } from '@heroicons/react/24/outline';

export default function InputModal({ isOpen, title, defaultValue = '', placeholder = '', onConfirm, onClose, lang }) {
  const [value, setValue] = useState(defaultValue);
  const inputRef = useRef(null);

  useEffect(() => {
    if (isOpen) {
      setValue(defaultValue);
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [isOpen, defaultValue]);

  if (!isOpen) return null;

  const handleSubmit = (e) => {
    e.preventDefault();
    onConfirm(value);
    onClose();
  };

  const t = {
    zh: { cancel: '取消', confirm: '确定' },
    en: { cancel: 'Cancel', confirm: 'Confirm' }
  }[lang] || { cancel: 'Cancel', confirm: 'Confirm' };

  return (
    <motion.div 
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm" 
      onClick={onClose}
    >
      <motion.div 
        initial={{ opacity: 0, scale: 0.95, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 10 }}
        transition={{ type: "spring", stiffness: 400, damping: 30 }}
        onClick={(e) => e.stopPropagation()}
        className="bg-white/90 backdrop-blur-2xl rounded-[32px] shadow-2xl w-full max-w-xs overflow-hidden border border-white/20 p-6 flex flex-col gap-4"
      >
        <h3 className="text-lg font-semibold text-slate-800 text-center">{title}</h3>
        
        <form onSubmit={handleSubmit} className="flex flex-col gap-4 w-full">
          <input
            ref={inputRef}
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={placeholder}
            className="w-full px-4 py-3 bg-slate-50/50 border border-slate-200 rounded-2xl focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all text-slate-700 text-center"
          />
          
          <div className="grid grid-cols-2 gap-3 w-full mt-2">
            <button
              type="button"
              onClick={onClose}
              className="w-full py-3 bg-slate-100 text-slate-600 rounded-2xl font-medium hover:bg-slate-200 transition-colors text-sm"
            >
              {t.cancel}
            </button>
            <button
              type="submit"
              disabled={!value.trim()}
              className="w-full py-3 rounded-2xl bg-indigo-500 text-white font-medium hover:bg-indigo-600 disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-lg shadow-indigo-200 text-sm"
            >
              {t.confirm}
            </button>
          </div>
        </form>
      </motion.div>
    </motion.div>
  );
}
