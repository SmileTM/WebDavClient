import React, { useState } from 'react';
import api from './api';
import clsx from 'clsx';
// import { XMarkIcon, ServerStackIcon } from '@heroicons/react/24/outline';
import { translations } from './i18n';

const AddDriveModal = ({ onClose, onAdded, lang = 'en' }) => {
  const t = translations[lang];
  const [loading, setLoading] = useState(false);
  const [testStatus, setTestStatus] = useState({ type: 'idle', msg: '' });
  const [formData, setFormData] = useState({
    name: '',
    url: '',
    username: '',
    password: ''
  });

  const handleTest = async () => {
    if (!formData.url) {
      setTestStatus({ type: 'error', msg: t.urlRequired });
      return;
    }
    setTestStatus({ type: 'testing', msg: t.testing });
    try {
      await api.testConnection(formData);
      setTestStatus({ type: 'success', msg: t.connectionSuccess });
    } catch (err) {
      setTestStatus({ type: 'error', msg: t.connectionFailed });
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (loading) return; 
    setLoading(true);
    setTestStatus({ type: 'testing', msg: t.testing });
    
    try {
      if (!formData.name || !formData.url) {
        alert(t.nameUrlRequired);
        setLoading(false);
        return;
      }

      // Step 1: Verify Connection First
      try {
        await api.testConnection(formData);
      } catch (testErr) {
        setTestStatus({ type: 'error', msg: t.connectionFailed });
        // Don't proceed if test fails
        setLoading(false);
        return; 
      }

      // Step 2: Save Drive
      const drivePayload = {
        type: 'webdav',
        quota: null,
        ...formData
      };

      const newDrive = await api.addDrive(drivePayload);
      onAdded(newDrive); 
      onClose();
    } catch (err) {
      console.error(err);
      const msg = err.response?.data?.error || err.message || JSON.stringify(err);
      if (err.response?.status === 409) {
        if (msg.includes('Name')) {
          alert(t.nameTaken);
        } else {
          alert(t.driveAccountAdded);
        }
      } else {
        alert(`${t.failedToAdd}: ${msg}`);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md overflow-hidden">
        
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-800 flex items-center gap-2">
            <span className="text-xl">☁️</span>
            {t.modalTitle}
          </h2>
          <button onClick={onClose} className="p-1 rounded-full hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition-colors">
            <span>✕</span>
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          
          <div>
            <label htmlFor="drive-name" className="block text-xs font-medium text-slate-500 mb-1">{t.displayName}</label>
            <input 
              id="drive-name"
              name="name"
              type="text" 
              placeholder="e.g. My Drive"
              className="w-full px-3 py-2 rounded-lg border border-slate-200 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-50 outline-none transition-all text-sm"
              value={formData.name}
              onChange={e => setFormData({...formData, name: e.target.value})}
            />
          </div>

          <div>
            <label htmlFor="drive-url" className="block text-xs font-medium text-slate-500 mb-1">{t.webdavUrl}</label>
            <input 
              id="drive-url"
              name="url"
              type="url" 
              placeholder="https://dav.example.com/webdav/"
              className="w-full px-3 py-2 rounded-lg border border-slate-200 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-50 outline-none transition-all text-sm"
              value={formData.url}
              onChange={e => setFormData({...formData, url: e.target.value})}
            />
            <p className="mt-1 text-[10px] text-slate-400">
              {t.tipRoot}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor="drive-username" className="block text-xs font-medium text-slate-500 mb-1">{t.username}</label>
              <input 
                id="drive-username"
                name="username"
                type="text" 
                autoComplete="username"
                className="w-full px-3 py-2 rounded-lg border border-slate-200 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-50 outline-none transition-all text-sm"
                value={formData.username}
                onChange={e => setFormData({...formData, username: e.target.value})}
              />
            </div>
            <div>
              <label htmlFor="drive-password" className="block text-xs font-medium text-slate-500 mb-1">{t.password}</label>
              <input 
                id="drive-password"
                name="password"
                type="password" 
                autoComplete="current-password"
                className="w-full px-3 py-2 rounded-lg border border-slate-200 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-50 outline-none transition-all text-sm"
                value={formData.password}
                onChange={e => setFormData({...formData, password: e.target.value})}
              />
            </div>
          </div>

          {/* Status Message */}
          {testStatus.type !== 'idle' && (
            <div className={clsx(
              "text-xs px-3 py-2 rounded-lg",
              testStatus.type === 'success' ? "bg-green-50 text-green-600" : 
              testStatus.type === 'error' ? "bg-red-50 text-red-600" : "bg-slate-50 text-slate-500"
            )}>
              {testStatus.msg}
            </div>
          )}

          <div className="pt-2 flex justify-end gap-2">
            <button 
              type="button" 
              onClick={handleTest}
              disabled={testStatus.type === 'testing'}
              className="mr-auto px-4 py-2 rounded-lg text-sm font-medium border border-slate-200 text-slate-600 hover:bg-slate-50 transition-colors"
            >
              {t.testConnection}
            </button>

            <button 
              type="button" 
              onClick={onClose}
              className="px-4 py-2 rounded-lg text-sm font-medium border border-slate-200 text-slate-500 hover:bg-slate-50 hover:text-slate-700 transition-colors"
            >
              {t.cancel}
            </button>
            <button 
              type="submit" 
              disabled={loading}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-700 active:scale-95 transition-all shadow-md shadow-indigo-200 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? t.adding : t.connectDrive}
            </button>
          </div>

        </form>
      </div>
    </div>
  );
};

export default AddDriveModal;