import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useDropzone } from 'react-dropzone';
import { motion, AnimatePresence } from 'framer-motion';
import api from './api';
import { Capacitor } from '@capacitor/core';
import { App as CapApp } from '@capacitor/app';
import { 
  FolderIcon, 
  DocumentIcon, 
  PhotoIcon, 
  VideoCameraIcon, 
  ChevronLeftIcon,
  PlusIcon,
  HomeIcon,
  ArrowPathIcon,
  CloudArrowUpIcon,
  ScissorsIcon,
  ClipboardDocumentCheckIcon,
  QueueListIcon,
  RectangleGroupIcon,
  Bars3Icon,
  ServerStackIcon,
  Cog6ToothIcon,
  PlusCircleIcon,
  XMarkIcon,
  TrashIcon,
  MagnifyingGlassIcon,
  PencilIcon,
  AdjustmentsHorizontalIcon,
  ChevronUpIcon,
  ChevronDownIcon,
  GlobeAltIcon,
  DocumentDuplicateIcon
} from '@heroicons/react/24/outline';
import clsx from 'clsx';
import PreviewModal from './PreviewModal';
import AddDriveModal from './AddDriveModal';
import InputModal from './InputModal';
import { translations } from './i18n';

// --- Icons Helper ---
const getFileIcon = (file) => {
  if (file.isDirectory) return <FolderIcon className="w-8 h-8 text-indigo-400" />;
  if (file.type?.startsWith('image')) return <PhotoIcon className="w-8 h-8 text-pink-400" />;
  if (file.type?.startsWith('video')) return <VideoCameraIcon className="w-8 h-8 text-blue-400" />;
  return <DocumentIcon className="w-8 h-8 text-slate-400" />;
};

const formatSize = (bytes) => {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
};

// --- Components ---

const FileItem = ({ file, selectedPaths, toggleSelection, handleNavigate, handleMove, viewMode, onPreview, activeDrive, isSelectionMode }) => {
  const isSelected = selectedPaths.has(file.path);
  const fullPath = file.path;
  const [isDragOver, setIsDragOver] = useState(false);
  const timerRef = useRef(null);
  const pointerDownPos = useRef(null);
  const [isLongPress, setIsLongPress] = useState(false);
  const isList = viewMode === 'list';
  const [thumbnailUrl, setThumbnailUrl] = useState('');

  // Safe Thumbnail Logic
  const isImage = !file.isDirectory && /\.(jpg|jpeg|png|gif|webp|svg|bmp)$/i.test(file.name);
  const isPDF = !file.isDirectory && /\.pdf$/i.test(file.name);

  useEffect(() => {
    let active = true;
    if (isImage) {
        // Delay slightly to prioritize UI render
        const load = async () => {
            try {
                const url = await api.getFileUrl(file.path, activeDrive || 'local');
                if (active && url) setThumbnailUrl(url);
            } catch (e) {
                // Ignore error
            }
        };
        load();
    } else {
        setThumbnailUrl('');
    }
    return () => { active = false; };
  }, [file.path, activeDrive, isImage]);

  // --- Long Press Logic ---
  const startPress = (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    setIsLongPress(false);
    pointerDownPos.current = { x: e.clientX, y: e.clientY };
    timerRef.current = setTimeout(() => {
      toggleSelection(fullPath);
      setIsLongPress(true);
      if (window.navigator.vibrate) window.navigator.vibrate(50);
    }, 500); // Increased to 500ms for better stability
  };

  const handlePointerMove = (e) => {
      if (timerRef.current && pointerDownPos.current) {
          const moveX = Math.abs(e.clientX - pointerDownPos.current.x);
          const moveY = Math.abs(e.clientY - pointerDownPos.current.y);
          if (moveX > 10 || moveY > 10) { // Cancel if moved more than 10px
              clearTimeout(timerRef.current);
              timerRef.current = null;
          }
      }
  };

  const endPress = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    pointerDownPos.current = null;
  };

  const handleDragStart = (e) => {
    // Internal Move Logic
    const itemsToMove = isSelected && selectedPaths.size > 0 ? Array.from(selectedPaths) : [fullPath];
    e.dataTransfer.setData('application/json', JSON.stringify({ items: itemsToMove }));
    
    // Electron Native Drag (Drag-Out)
    if (window.electron && window.electron.startDrag) {
        e.preventDefault();
        window.electron.startDrag(itemsToMove, activeDrive || 'local');
        return;
    }
    
    // External Download Logic (Chrome/Edge only, Single file)
    if (!file.isDirectory) {
       // ... existing drag logic ...
    }
    e.dataTransfer.effectAllowed = 'all';
  };

  const handleDragOver = (e) => {
    if (!file.isDirectory) return;
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  };

  const handleDragLeave = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  };

  const handleDrop = (e) => {
    if (!file.isDirectory) return;
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    const data = e.dataTransfer.getData('application/json');
    if (data) {
      try {
        const parsed = JSON.parse(data);
        if (Array.isArray(parsed.items)) {
          if (parsed.items.includes(fullPath)) return;
          handleMove(parsed.items, fullPath);
        }
      } catch (err) {}
    }
  };

  return (
    <motion.div
      draggable
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onPointerDown={startPress}
      onPointerMove={handlePointerMove}
      onPointerUp={endPress}
      onPointerLeave={endPress}
      onContextMenu={(e) => e.preventDefault()} 
      initial={{ opacity: 0, y: 10 }}
      animate={{
        opacity: 1, 
        y: 0,
        scale: isDragOver ? 1.02 : (isSelected ? 0.98 : 1),
        backgroundColor: isDragOver ? '#f1f5f9' : (isSelected ? '#f8fafc' : '#ffffff'), // Highlight selected bg slightly
        borderColor: isDragOver ? '#cbd5e1' : (isSelected ? '#e2e8f0' : 'rgba(0, 0, 0, 0)') // Add border when selected
      }}
      whileHover={{ scale: isSelected ? 0.98 : 1.01 }}
      className={clsx(
        "relative shadow-island hover:shadow-island-hover flex items-center cursor-pointer transition-all border-2 group select-none touch-pan-y",
        isList 
          ? "p-2 px-3 gap-3 rounded-xl" 
          : "flex-col p-4 gap-2 rounded-2xl text-center aspect-[4/3]"
      )}
      onClick={(e) => {
        if (isLongPress) return; 
        if (isSelectionMode) toggleSelection(fullPath); // Click anywhere toggles if in selection mode
        else {
          if (file.isDirectory) handleNavigate(file.path);
          else onPreview(file);
        }
      }}
    >
      <div className={clsx(
        "rounded-xl pointer-events-none flex items-center justify-center transition-transform group-hover:scale-110 duration-300 overflow-hidden relative", 
        isList ? "p-1.5 bg-slate-50 w-9 h-9" : "flex-1 w-full"
      )}>
        {/* Default Icon / PDF Icon */}
        {isPDF ? (
           <div className={clsx("flex flex-col items-center justify-center text-red-500", isList ? "" : "w-full h-full bg-red-50 rounded-lg")}>
             <DocumentIcon className={clsx(isList ? "w-6 h-6" : "w-10 h-10")} />
             {!isList && <span className="text-[8px] font-bold mt-1">PDF</span>}
           </div>
        ) : (
          isList 
            ? React.cloneElement(getFileIcon(file), { className: "w-6 h-6" }) 
            : React.cloneElement(getFileIcon(file), { className: "w-12 h-12" })
        )}
        
        {/* Safe Thumbnail Overlay */}
        {isImage && thumbnailUrl && (
          <img 
            src={thumbnailUrl} 
            alt="" 
            loading="lazy"
            className="absolute inset-0 w-full h-full object-cover bg-white"
            style={{ textIndent: '-10000px' }} 
          />
        )}
      </div>
      
      <div className={clsx("pointer-events-none w-full", isList ? "flex-1 min-w-0 flex items-center justify-between gap-4" : "")}>
        <div className={clsx("min-w-0 flex-1", isList ? "" : "px-1")}>
          <h3 className={clsx(
            "font-medium text-slate-700 truncate", 
            isList ? "text-sm" : "text-[11px] sm:text-xs"
          )}>
            {file.name}
          </h3>
          {!isList && (
            <p className="text-[9px] text-slate-400 mt-0.5 truncate leading-none">
              {file.isDirectory ? 'Folder' : formatSize(file.size)} • {new Date(file.mtime).toLocaleDateString()}
            </p>
          )}
        </div>

        {isList && (
          <div className="flex flex-col items-end text-right shrink-0 leading-tight">
            <span className="text-[10px] text-slate-500 tabular-nums">{file.isDirectory ? 'Folder' : formatSize(file.size)}</span>
            <span className="text-[9px] text-slate-400 tabular-nums">{new Date(file.mtime).toLocaleDateString()}</span>
          </div>
        )}
      </div>
      
      {/* Checkbox Indicator */}
      <div 
        onClick={(e) => { e.stopPropagation(); toggleSelection(fullPath); }} 
        className={clsx(
            "rounded-full border-2 flex items-center justify-center transition-all shrink-0", 
            isList ? "w-4 h-4" : "absolute top-2 right-2 w-5 h-5", 
            isSelected 
                ? "bg-slate-800 border-slate-800 opacity-100 scale-100" 
                : isSelectionMode 
                    ? "border-slate-300 opacity-100 scale-100 bg-white/50" // Show empty checkbox in selection mode
                    : "border-slate-200 opacity-0 md:group-hover:opacity-100 scale-75" // Hide otherwise, hover only on desktop
        )}
      >
         {isSelected && <div className={clsx("bg-white rounded-full", isList ? "w-1.5 h-1.5" : "w-2 h-2")} />} 
      </div>
    </motion.div>
  );
};

function App() {
  const [currentPath, setCurrentPath] = useState('/');
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [isIslandExpanded, setIsIslandExpanded] = useState(false);
  const [selectedPaths, setSelectedPaths] = useState(new Set());
  const [clipboard, setClipboard] = useState(null); 
  const [refreshKey, setRefreshKey] = useState(0);
  const [viewMode, setViewMode] = useState('grid');
  const [previewFile, setPreviewFile] = useState(null);
  const [drives, setDrives] = useState(() => {
    try {
      const cached = localStorage.getItem('cached_drives');
      return cached ? JSON.parse(cached) : [{ id: 'local', name: 'Local Storage', type: 'local', quota: { used: 0, total: 100 * 1024 * 1024 * 1024 } }];
    } catch (e) {
      return [{ id: 'local', name: 'Local Storage', type: 'local', quota: { used: 0, total: 100 * 1024 * 1024 * 1024 } }];
    }
  });
  const [activeDrive, setActiveDrive] = useState('local');
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isAddDriveOpen, setIsAddDriveOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [isGlobalSearch, setIsGlobalSearch] = useState(false);
  const [searchResults, setSearchResults] = useState([]);
  const [isSearching, setIsSearching] = useState(false);

  const handleGlobalSearch = async () => {
      if (!searchQuery.trim()) return;
      setIsSearching(true);
      setIsGlobalSearch(true);
      try {
          if (api.searchItems) {
              const results = await api.searchItems(searchQuery, activeDrive, '/'); 
              setSearchResults(results);
          } else {
              alert("Global search not supported on mobile yet");
              setIsGlobalSearch(false);
          }
      } catch (err) {
          console.error(err);
          alert('Search failed');
          setIsGlobalSearch(false);
      } finally {
          setIsSearching(false);
      }
  };

  useEffect(() => {
      if (!searchQuery) {
          setIsGlobalSearch(false);
          setSearchResults([]);
      }
  }, [searchQuery]);
  const [page, setPage] = useState(1);
  const [sortConfig, setSortConfig] = useState({ key: 'type', direction: 'asc' });
  const [isSortMenuOpen, setIsSortMenuOpen] = useState(false);
  const [progress, setProgress] = useState(null); 
  const [inputModal, setInputModal] = useState({ isOpen: false, title: '', defaultValue: '', onConfirm: () => {} });

  // Language State
  const [lang, setLang] = useState(() => localStorage.getItem('app_lang') || 'zh');
  const t = translations[lang];

  const toggleLang = () => {
    const newLang = lang === 'en' ? 'zh' : 'en';
    setLang(newLang);
    localStorage.setItem('app_lang', newLang);
  };

  const PAGE_SIZE = 50;
  
  const fileInputRef = useRef(null);
  
  const isElectron = /Electron/.test(navigator.userAgent);
  const isMac = /Mac/.test(navigator.platform);
  const isMacDesktop = isElectron && isMac;

  const fetchDrives = () => {
    api.getDrives()
      .then(list => {
        setDrives(list);
        localStorage.setItem('cached_drives', JSON.stringify(list));
      })
      .catch(() => setDrives([]));
  };

  useEffect(() => { fetchDrives(); }, []);

  // Ref to keep handlers fresh
  const handleGoUpRef = useRef(null);
  const setIsSidebarOpenRef = useRef(setIsSidebarOpen); // setIsSidebarOpen is state setter, likely hoisted or safe if from useState
  const isSidebarOpenRef = useRef(isSidebarOpen);
  const currentPathRef = useRef(currentPath);
  const fetchFilesRef = useRef(null); // fetchFiles is defined later
  const selectedPathsRef = useRef(selectedPaths);
  const previewFileRef = useRef(previewFile);

  // Note: specific useEffects to update these refs are moved to bottom of component to avoid TDZ


  // --- Global Gestures & Hardware Back Button ---
  useEffect(() => {
    // Hardware Back Button
    const backListener = CapApp.addListener('backButton', ({ canGoBack }) => {
      if (previewFileRef.current) {
        setPreviewFile(null);
      } else if (isSidebarOpenRef.current) {
        setIsSidebarOpenRef.current(false);
      } else if (selectedPathsRef.current.size > 0) {
        setSelectedPaths(new Set());
      } else if (currentPathRef.current !== '/') {
        if (handleGoUpRef.current) handleGoUpRef.current();
      } else {
        CapApp.exitApp();
      }
    });

    // Touch Gestures
    let touchStartX = 0;
    let touchStartY = 0;
    let isPulling = false;

    const handleTouchStart = (e) => {
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
        
        // Check if we are at the top of the scroll container
        const scrollContainer = document.getElementById('file-list-container');
        if (scrollContainer && scrollContainer.scrollTop === 0) {
            isPulling = true;
        } else {
            isPulling = false;
        }
    };

    const handleTouchMove = (e) => {
        // Optional: Add visual feedback for pull-to-refresh here
    };

    const handleTouchEnd = (e) => {
        const touchEndX = e.changedTouches[0].clientX;
        const touchEndY = e.changedTouches[0].clientY;
        
        const deltaX = touchEndX - touchStartX;
        const deltaY = touchEndY - touchStartY;
        const absDeltaX = Math.abs(deltaX);
        const absDeltaY = Math.abs(deltaY);

        // Horizontal Swipes (Dominant X movement)
        if (absDeltaX > absDeltaY && absDeltaX > 50) {
            // Right Swipe (->)
            if (deltaX > 0) {
                if (isSidebarOpenRef.current) return; // Already open
                
                // User Request: Non-edge area swipe right -> Open Sidebar
                // Edge area (<40px) is reserved for System Back Gesture
                if (touchStartX > 40) {
                    setIsSidebarOpenRef.current(true);
                }
            }
            // Left Swipe (<-)
            else {
                if (isSidebarOpenRef.current) {
                    // Close Sidebar
                    setIsSidebarOpenRef.current(false);
                }
            }
        }
        
        // Vertical Pull (Pull to Refresh)
        // Must be dominant Y, downward, start from top, and significant distance
        if (isPulling && deltaY > 100 && absDeltaY > absDeltaX * 2) {
             // Trigger Refresh
             if (window.navigator.vibrate) window.navigator.vibrate(20);
             if(fetchFilesRef.current) fetchFilesRef.current(currentPathRef.current);
        }
    };

    window.addEventListener('touchstart', handleTouchStart);
    window.addEventListener('touchmove', handleTouchMove);
    window.addEventListener('touchend', handleTouchEnd);

    return () => {
        backListener.then(h => h.remove());
        window.removeEventListener('touchstart', handleTouchStart);
        window.removeEventListener('touchmove', handleTouchMove);
        window.removeEventListener('touchend', handleTouchEnd);
    };
  }, []); 

  // Filtered files
  const filesToDisplay = isGlobalSearch ? searchResults : files;
  const filteredFiles = useMemo(() => filesToDisplay.filter(f => 
    // Always filter by query (refine global results or filter local files)
    f.name.toLowerCase().includes(searchQuery.toLowerCase())
  ), [filesToDisplay, searchQuery]);

  // Sorted files
  const sortedFiles = useMemo(() => {
    let sorted = [...filteredFiles];
    sorted.sort((a, b) => {
      // Always keep folders on top
      if (a.isDirectory !== b.isDirectory) {
         return a.isDirectory ? -1 : 1; 
      }
      
      let res = 0;
      switch (sortConfig.key) {
        case 'name': 
          res = a.name.localeCompare(b.name); 
          break;
        case 'date': 
          res = new Date(a.mtime) - new Date(b.mtime);
          break;
        case 'type':
          const extA = a.name.split('.').pop();
          const extB = b.name.split('.').pop();
          res = extA.localeCompare(extB);
          break;
        default: break;
      }
      
      // Apply direction (for Date, desc usually means newest first)
      if (sortConfig.direction === 'desc') res = -res;
      
      return res;
    });
    return sorted;
  }, [filteredFiles, sortConfig]);
  
  // Reset pagination on search/sort
  useEffect(() => { setPage(1); }, [searchQuery, sortConfig]);

  // Infinite Scroll Handler
  const handleScroll = (e) => {
    const { scrollTop, scrollHeight, clientHeight } = e.target;
    if (scrollTop + clientHeight >= scrollHeight - 100) {
      if (sortedFiles.length > page * PAGE_SIZE) {
        setPage(prev => prev + 1);
      }
    }
  };

  const handleSort = (key) => {
    setSortConfig(prev => ({
      key,
      direction: prev.key === key && prev.direction === 'asc' ? 'desc' : 'asc'
    }));
    setIsSortMenuOpen(false);
  };

  const fetchFiles = async (path) => {
    setLoading(true);
    try {
      const files = await api.getFiles(path, activeDrive);
      setFiles(files);
      setPage(1); // Reset page on new load
      setSelectedPaths(new Set()); 
      setRefreshKey(prev => prev + 1);
    } catch (err) {
      console.error(err);
      const msg = err.message || 'Failed to load files';
      // alert(`Debug Error: ${msg}`); // Optional debug
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchFiles(currentPath); }, [currentPath, activeDrive]);

  // --- Keyboard Shortcuts (Esc) ---
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        if (inputModal.isOpen) setInputModal(prev => ({ ...prev, isOpen: false }));
        else if (previewFile) setPreviewFile(null);
        else if (isAddDriveOpen) setIsAddDriveOpen(false);
        else if (isIslandExpanded) setIsIslandExpanded(false);
        else if (selectedPaths.size > 0) setSelectedPaths(new Set());
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [previewFile, isAddDriveOpen, isIslandExpanded, selectedPaths, inputModal.isOpen]);

  // Handle activeDrive persistence
  const handleDriveChange = (id) => {
    setActiveDrive(id);
    localStorage.setItem('last_drive', id);
    setCurrentPath('/');
    localStorage.setItem('last_path', '/');
    setIsSidebarOpen(false);
  };

  const handleNavigate = (path) => {
    setCurrentPath(path);
    localStorage.setItem('last_path', path);
  };

  const handleGoUp = () => {
    if (currentPath === '/') return;
    const parent = currentPath.split('/').slice(0, -1).join('/') || '/';
    setCurrentPath(parent);
    localStorage.setItem('last_path', parent);
  };

  const handleUpload = async (acceptedFiles) => {
    if (acceptedFiles.length === 0) return;
    
    // Duplicate Check
    const duplicates = acceptedFiles.filter(file => files.some(existing => existing.name === file.name));
    if (duplicates.length > 0) {
      if (!confirm(t.confirmOverwrite.replace('{count}', duplicates.length))) return;
    }

    setUploading(true);
    setProgress({ current: 0, total: acceptedFiles.length, filename: 'Preparing...' });
    
    try {
      await api.uploadFiles(currentPath, acceptedFiles, activeDrive, (current, total, filename) => {
          setProgress({ current, total, filename });
      });
      await fetchFiles(currentPath);
      setIsIslandExpanded(false);
    } catch (err) { alert(t.uploadFailed); } finally { 
        setUploading(false); 
        setProgress(null);
    }
  };

  const onDrop = useCallback(acceptedFiles => { handleUpload(acceptedFiles); }, [currentPath, activeDrive, files, t]); // Add files/t dependency
  const { getRootProps, getInputProps, isDragActive } = useDropzone({ onDrop, noClick: true, noKeyboard: true });

  const toggleSelection = (path) => { const newSet = new Set(selectedPaths); if (newSet.has(path)) newSet.delete(path); else newSet.add(path); setSelectedPaths(newSet); };
  
  const handleDelete = async () => {
    if (!confirm(t.confirmDeleteItems.replace('{count}', selectedPaths.size))) return;
    try { await api.deleteItems(Array.from(selectedPaths), activeDrive); fetchFiles(currentPath); setSelectedPaths(new Set()); } catch (err) { alert(t.deleteFailed); }
  };
  const handleMove = async (items, destination) => {
    if (items.includes(destination)) return;
    try { await api.moveItems(items, destination, activeDrive); fetchFiles(currentPath); setSelectedPaths(new Set()); } catch (err) { alert(t.moveFailed); }
  };
  const handleCut = () => { setClipboard({ mode: 'move', items: Array.from(selectedPaths), driveId: activeDrive }); setSelectedPaths(new Set()); };
  const handleCopy = () => { setClipboard({ mode: 'copy', items: Array.from(selectedPaths), driveId: activeDrive }); setSelectedPaths(new Set()); };
  
  const handlePaste = async () => { 
    if (!clipboard || !clipboard.items) return; 
    
    // Check if cross-drive
    const sourceDrive = clipboard.driveId || activeDrive; 
    const destDrive = activeDrive;
    const isMove = clipboard.mode === 'move';

    try {
        const total = clipboard.items.length;
        setProgress({ current: 0, total, filename: 'Preparing...' });
        
        if (sourceDrive === destDrive) {
            // Same drive
            if (isMove) {
                await api.moveItems(clipboard.items, currentPath, activeDrive);
            } else {
                // Same drive copy
                await api.crossDriveTransfer(clipboard.items, sourceDrive, currentPath, destDrive, false, (current, total, filename) => {
                    setProgress({ current, total, filename });
                });
            }
        } else {
            // Cross drive
            await api.crossDriveTransfer(clipboard.items, sourceDrive, currentPath, destDrive, isMove, (current, total, filename) => {
                setProgress({ current, total, filename });
            });
        }
        fetchFiles(currentPath); 
        setClipboard(null); 
    } catch (err) {
        alert((isMove ? t.moveFailed : 'Copy Failed') + ': ' + (err.message || ''));
    } finally {
        setProgress(null);
    }
  };
  
  const handleRename = () => {
    if (selectedPaths.size !== 1) return;
    const oldPath = Array.from(selectedPaths)[0];
    const oldName = oldPath.split('/').pop();
    
    setInputModal({
      isOpen: true,
      title: t.renamePrompt,
      defaultValue: oldName,
      onConfirm: async (newName) => {
        if (!newName || newName === oldName) return;
        if (files.some(f => f.name === newName)) {
            alert(t.fileExists);
            return;
        }
        try {
            await api.renameItem(oldPath, newName, currentPath, activeDrive);
            fetchFiles(currentPath);
            setSelectedPaths(new Set());
        } catch (err) { alert(t.renameFailed); }
      }
    });
  };

  const removeDrive = async (id, e) => {
    e.stopPropagation();
    if (!confirm(t.confirmRemoveDrive)) return;
    try {
      await api.removeDrive(id);
      if (activeDrive === id) {
        setActiveDrive('local');
        localStorage.setItem('last_drive', 'local');
        setCurrentPath('/');
        localStorage.setItem('last_path', '/');
      }
      fetchDrives();
    } catch (err) { alert('Failed to remove drive'); }
  };

  const handleEditDrive = (id, currentName, e) => {
    e.stopPropagation();
    
    setInputModal({
        isOpen: true,
        title: t.renamePrompt,
        defaultValue: currentName,
        onConfirm: async (newName) => {
            if (!newName || newName === currentName) return;
            try {
                await api.updateDrive(id, { name: newName });
                setDrives(prev => prev.map(d => d.id === id ? { ...d, name: newName } : d));
            } catch (err) {
                if (err.response?.status === 409) alert(t.nameTaken);
                else alert('Failed to update name');
            }
        }
    });
  };

  const isSelectionMode = selectedPaths.size > 0;
  const hasClipboard = clipboard && clipboard.items.length > 0;

  // --- Moved UseEffects to avoid TDZ ---
  useEffect(() => { handleGoUpRef.current = handleGoUp; }, [handleGoUp]);
  useEffect(() => { setIsSidebarOpenRef.current = setIsSidebarOpen; }, [setIsSidebarOpen]);
  useEffect(() => { isSidebarOpenRef.current = isSidebarOpen; }, [isSidebarOpen]);
  useEffect(() => { currentPathRef.current = currentPath; }, [currentPath]);
  useEffect(() => { fetchFilesRef.current = fetchFiles; }, [fetchFiles]);
  useEffect(() => { selectedPathsRef.current = selectedPaths; }, [selectedPaths]);
  useEffect(() => { previewFileRef.current = previewFile; }, [previewFile]);

    return (

      <div {...getRootProps()} className="flex h-screen bg-main-bg selection-none outline-none overflow-hidden font-sans">

        <input {...getInputProps()} name="dropzone-file" id="dropzone-file" />

        <input 

          type="file" 

          name="manual-file-upload"

          id="manual-file-upload"

          multiple 

          className="hidden" 

          ref={fileInputRef} 

          onChange={(e) => handleUpload(Array.from(e.target.files))} 

        />

      {/* --- Sidebar (Desktop: Floating Island, Mobile: Fixed/Drawer) --- */}
      <div className={clsx(
        "fixed z-50 bg-white/95 backdrop-blur-xl border border-white/40 shadow-2xl transition-all duration-300 ease-in-out md:shadow-2xl",
        "m-4 rounded-[28px] h-[calc(100vh-2rem)] w-60",
        "left-0 md:static md:w-64 md:translate-x-0 md:m-4",
        isSidebarOpen ? "translate-x-0 opacity-100" : "-translate-x-[120%] opacity-0 md:translate-x-0 md:opacity-100 pointer-events-none md:pointer-events-auto"
      )}
      style={{ paddingTop: 'env(safe-area-inset-top)' }}
      >
        <div className="flex flex-col h-full p-4">
          <div className={clsx(
            "flex flex-col items-center gap-3 px-2 py-4 mb-6",
            isMacDesktop && "pt-10" // Space for traffic lights
          )}>
            <div className="w-10 h-10 bg-indigo-600 rounded-xl flex items-center justify-center text-white shadow-lg shadow-indigo-100">
              <ServerStackIcon className="w-6 h-6" />
            </div>
            <span className="text-lg font-bold text-slate-800 tracking-tight">{t.appTitle}</span>
          </div>
          <div className="flex-1 overflow-y-auto space-y-1">
            <p className="px-3 text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">{t.drives}</p>
            {drives.length === 0 && (
              <div className="px-3 text-xs text-red-400 italic">{t.noDrives}</div>
            )}
            {(Array.isArray(drives) ? drives : []).map(drive => (
              <div
                key={drive.id}
                onClick={() => handleDriveChange(drive.id)}
                className={clsx(
                  "w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all group cursor-pointer",
                  activeDrive === drive.id 
                    ? "bg-indigo-50 text-indigo-700 shadow-sm" 
                    : "text-slate-600 hover:bg-slate-100"
                )}
              >
                <div className="shrink-0 pt-0.5">
                  <ServerStackIcon className={clsx("w-5 h-5", activeDrive === drive.id ? "text-indigo-600" : "text-slate-400")} />
                </div>
                
                <div className="flex-1 min-w-0 flex flex-col items-start gap-1">
                  <span className="truncate w-full text-left">
                    {drive.id === 'local' ? t.localDriveName : drive.name}
                  </span>
                  
                  {drive.quota && drive.quota.total > 0 && (
                    <div className="w-full">
                      <div className="flex justify-between items-center mb-0.5">
                         <span className="text-[9px] opacity-70">{formatSize(drive.quota.used)} / {formatSize(drive.quota.total)}</span>
                      </div>
                      <div className="w-full h-1 bg-slate-200 rounded-full overflow-hidden">
                        <div 
                          className={clsx("h-full rounded-full", activeDrive === drive.id ? "bg-indigo-500" : "bg-slate-400")}
                          style={{ width: `${Math.min((drive.quota.used / drive.quota.total) * 100, 100)}%` }}
                        ></div>
                      </div>
                    </div>
                  )}
                </div>

                {drive.id !== 'local' && (
                  <div className="flex items-center shrink-0 gap-1 opacity-0 group-hover:opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-all">
                    <button 
                      onClick={(e) => handleEditDrive(drive.id, drive.name, e)}
                      className="p-1.5 rounded-full hover:bg-slate-200 text-slate-400 hover:text-slate-600 focus:opacity-100"
                      title={t.rename}
                    >
                      <PencilIcon className="w-3.5 h-3.5" />
                    </button>
                    <button 
                      onClick={(e) => removeDrive(drive.id, e)}
                      className="p-1.5 rounded-full hover:bg-red-100 text-slate-400 hover:text-red-500 focus:opacity-100"
                      title={t.delete}
                    >
                      <TrashIcon className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
          
          <button onClick={() => setIsAddDriveOpen(true)} className="mt-2 flex items-center justify-center gap-2 w-full py-2 text-sm font-medium text-indigo-600 hover:bg-indigo-50 rounded-xl transition-colors">
            <PlusCircleIcon className="w-5 h-5" /><span>{t.addDrive}</span>
          </button>

          {/* Sidebar Footer Extras */}
          <div className="mt-2 pt-2 border-t border-slate-100 flex items-center justify-start">
            <button
              onClick={toggleLang}
              className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-500 hover:text-indigo-600 transition-colors"
            >
              <GlobeAltIcon className="w-4 h-4 shrink-0" />
              <span>{lang === 'en' ? '英' : '中'}</span>
            </button>
          </div>
        </div>
      </div>

      {/* Overlay for Mobile Sidebar */}
      {isSidebarOpen && (
        <div 
          className="fixed inset-0 z-[49] bg-black/20 backdrop-blur-sm md:hidden cursor-pointer"
          onClick={() => setIsSidebarOpen(false)}
        />
      )}

      <div className="flex-1 flex flex-col h-full overflow-hidden relative">
        <div 
          className="sticky top-0 z-10 bg-main-bg/80 backdrop-blur-md border-b border-slate-100 transition-all"
          style={{ paddingTop: 'env(safe-area-inset-top)' }}
        >
          {/* Top Row: Sidebar, Back, Search, Actions */}
          <div className="flex items-center gap-2 px-4 sm:px-8 py-3">
            <button onClick={() => setIsSidebarOpen(true)} className="p-2 -ml-2 mr-1 hover:bg-white rounded-full md:hidden text-slate-600"><Bars3Icon className="w-6 h-6" /></button>
            
            {currentPath !== '/' && (
              <button 
                onClick={handleGoUp}
                className="p-2 hover:bg-white rounded-full transition-colors shrink-0"
              >
                <ChevronLeftIcon className="w-5 h-5 text-slate-600" />
              </button>
            )}

            {/* Search Input */}
            <div className="flex-1 relative group mx-1">
              <label htmlFor="search-files" className="sr-only">Search Files</label>
              {isSearching ? (
                  <ArrowPathIcon className="w-5 h-5 text-indigo-500 absolute left-3 top-1/2 -translate-y-1/2 animate-spin" />
              ) : (
                  <MagnifyingGlassIcon className="w-5 h-5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              )}
              <input 
                id="search-files"
                name="search"
                type="text" 
                placeholder={t.searchPlaceholder}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleGlobalSearch()}
                className="w-full bg-slate-100/50 hover:bg-slate-100 focus:bg-white border-none rounded-full py-2 pl-10 pr-4 text-sm outline-none ring-1 ring-transparent focus:ring-indigo-500/20 transition-all placeholder:text-slate-400 text-slate-600"
              />
            </div>
            
            <div className="flex items-center gap-1 sm:gap-2 shrink-0">
              {isSelectionMode ? (
                <button onClick={() => setSelectedPaths(new Set())} className="text-sm text-indigo-600 font-medium px-2 sm:px-4">
                  {t.cancel}
                </button>
              ) : hasClipboard ? (
                <button onClick={() => setClipboard(null)} className="text-sm text-slate-400 font-medium px-2 sm:px-4">
                  {t.cancelMove}
                </button>
              ) : (
                <>
                  {uploading && (
                     <div className="flex items-center gap-2 text-sm text-slate-500 mr-2 hidden sm:flex">
                       <ArrowPathIcon className="w-4 h-4 animate-spin" />
                       <span>{t.uploading}</span>
                     </div>
                  )}
                  
                  {/* Sort Menu */}
                  <div className="relative">
                    <button 
                      onClick={() => setIsSortMenuOpen(!isSortMenuOpen)}
                      className="p-2 hover:bg-white rounded-full text-slate-500 transition-colors"
                    >
                      <AdjustmentsHorizontalIcon className="w-6 h-6" />
                    </button>
                    {isSortMenuOpen && (
                      <>
                        <div className="fixed inset-0 z-10" onClick={() => setIsSortMenuOpen(false)} />
                        <div className="absolute right-0 top-full mt-2 w-32 bg-white rounded-xl shadow-xl border border-slate-100 z-20 overflow-hidden py-1">
                          {['name', 'date', 'type'].map(key => (
                            <button
                              key={key}
                              onClick={() => handleSort(key)}
                              className="w-full text-left px-4 py-2 text-sm text-slate-600 hover:bg-indigo-50 hover:text-indigo-600 flex items-center justify-between"
                            >
                              <span className="capitalize">{t[key] || key}</span>
                              {sortConfig.key === key && (
                                sortConfig.direction === 'asc' ? <ChevronUpIcon className="w-3 h-3" /> : <ChevronDownIcon className="w-3 h-3" />
                              )}
                            </button>
                          ))}
                        </div>
                      </>
                    )}
                  </div>

                  {/* View Mode Toggle */}
                  <button 
                    onClick={() => setViewMode(v => v === 'grid' ? 'list' : 'grid')}
                    className="p-2 hover:bg-white rounded-full text-slate-500 transition-colors"
                  >
                    {viewMode === 'grid' ? <QueueListIcon className="w-6 h-6" /> : <RectangleGroupIcon className="w-6 h-6" />}
                  </button>
                </>
              )}
            </div>
          </div>

          {/* Bottom Row: Breadcrumbs (Mobile: Small text, Desktop: Normal) */}
          <div className="px-4 sm:px-8 pb-3 pt-0 flex overflow-x-auto no-scrollbar mask-linear-fade">
            <div className="flex items-center gap-1 whitespace-nowrap text-slate-500">
              <button 
                onClick={() => handleNavigate('/')}
                className={clsx(
                  "p-1 rounded-lg transition-colors flex items-center",
                  currentPath === '/' ? "bg-indigo-50 text-indigo-700 font-bold" : "hover:bg-white hover:text-slate-700"
                )}
              >
                <HomeIcon className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
              </button>
              
              {currentPath !== '/' && currentPath.split('/').filter(Boolean).map((segment, index, arr) => {
                const segmentPath = '/' + arr.slice(0, index + 1).join('/');
                const isLast = index === arr.length - 1;
                return (
                  <div key={segmentPath} className="flex items-center">
                    <span className="text-slate-300 mx-0.5 text-xs">/</span>
                    <button
                      onClick={() => !isLast && handleNavigate(segmentPath)}
                      disabled={isLast}
                      className={clsx(
                        "px-1.5 py-0.5 rounded-lg transition-colors",
                        isLast 
                          ? "font-bold text-slate-800 cursor-default text-xs sm:text-sm" 
                          : "hover:bg-white hover:text-indigo-600 font-medium text-xs sm:text-sm"
                      )}
                    >
                      {segment}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <div 
          id="file-list-container"
          className="flex-1 overflow-y-auto p-4 sm:p-8 pb-32"
          onScroll={handleScroll}
        >
          <div className={clsx("grid gap-3 transition-all", viewMode === 'grid' ? "grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5" : "grid-cols-1")}>
            {loading && files.length === 0 ? (
              <div className="col-span-full py-20 text-center text-slate-400">{t.loading}</div>
            ) : files.length === 0 ? (
              <div className="col-span-full py-20 text-center flex flex-col items-center gap-3">
                 <div className="w-16 h-16 bg-white rounded-full shadow-island flex items-center justify-center"><FolderIcon className="w-8 h-8 text-slate-300" /></div>
                 <p className="text-slate-400">{t.emptyFolder}</p>
              </div>
            ) : sortedFiles.length === 0 ? (
              <div className="col-span-full py-20 text-center text-slate-400">{t.noResults}</div>
            ) : (
              <AnimatePresence mode='wait'>
                <motion.div 
                  key={refreshKey + searchQuery + sortConfig.key + sortConfig.direction} 
                  initial={{ opacity: 0.8, scale: 0.99 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ duration: 0.2 }}
                  className="contents" 
                >
                  {sortedFiles.slice(0, page * PAGE_SIZE).map(file => (
                    <FileItem 
                      key={file.path} 
                      file={file} 
                      selectedPaths={selectedPaths}
                      toggleSelection={toggleSelection}
                      handleNavigate={handleNavigate}
                      handleMove={handleMove}
                      viewMode={viewMode}
                      onPreview={setPreviewFile}
                      activeDrive={activeDrive}
                      isSelectionMode={selectedPaths.size > 0}
                    />
                  ))}
                </motion.div>
              </AnimatePresence>
            )}
          </div>
        </div>

        {/* Dynamic Island */}
        <div className="fixed bottom-8 left-0 right-0 flex justify-center z-40 pointer-events-none">
          <motion.div 
            onClick={(e) => e.stopPropagation()}
            className={clsx(
              "shadow-[0_20px_50px_rgba(0,0,0,0.1)] backdrop-blur-xl border border-white/20 pointer-events-auto flex items-center overflow-hidden transition-all duration-300 ease-spring",
              isSelectionMode ? "bg-red-50/90 w-[300px] h-14 rounded-full" : hasClipboard ? "bg-indigo-50/90 w-52 h-14 rounded-full" : isIslandExpanded ? "bg-white/90 w-72 h-20 rounded-[40px]" : "bg-white/80 w-32 h-14 rounded-full"
            )}
          >
            {isSelectionMode ? (
               <div className="w-full h-full flex items-center justify-around px-4">
                 <button onClick={handleDelete} className="text-red-500 font-medium text-xs hover:bg-red-100 px-2 py-1 rounded-lg whitespace-nowrap">
                    {t.delete} ({selectedPaths.size})
                 </button>
                 
                 <div className="w-px h-4 bg-red-100 shrink-0"></div>

                 {selectedPaths.size === 1 && (
                   <>
                     <button onClick={handleRename} className="text-slate-600 font-medium text-xs hover:bg-slate-100 px-2 py-1 rounded-lg whitespace-nowrap">
                        {t.rename}
                     </button>
                     <div className="w-px h-4 bg-slate-100 shrink-0"></div>
                   </>
                 )}

                 <button onClick={handleCut} className="text-slate-600 font-medium text-xs hover:bg-slate-100 px-2 py-1 rounded-lg whitespace-nowrap">
                    {t.move}
                 </button>
                 
                 <div className="w-px h-4 bg-slate-100 shrink-0"></div>

                 <button onClick={handleCopy} className="text-slate-600 font-medium text-xs hover:bg-slate-100 px-2 py-1 rounded-lg whitespace-nowrap flex items-center gap-1">
                    <DocumentDuplicateIcon className="w-3 h-3" />
                    {t.copy}
                 </button>
               </div>
            ) : hasClipboard ? (
               <button onClick={handlePaste} className="w-full h-full flex items-center justify-center gap-2 font-semibold text-indigo-600 hover:bg-indigo-100/50">
                  <ClipboardDocumentCheckIcon className="w-5 h-5" />
                  <span>{t.paste} ({clipboard.items.length})</span>
               </button>
            ) : (
              <>
                {!isIslandExpanded && (
                  <div className="w-full flex justify-between px-4 items-center h-full">
                    <button onClick={() => fetchFiles(currentPath)} className="p-2 hover:bg-slate-100 rounded-full text-slate-500">
                      <ArrowPathIcon className={clsx("w-6 h-6", (loading || uploading) && "animate-spin text-indigo-500")} />
                    </button>
                    <div className="w-px h-6 bg-slate-200"></div>
                    <button onClick={() => setIsIslandExpanded(true)} className="p-2 hover:bg-slate-100 rounded-full text-slate-500">
                      <PlusIcon className="w-6 h-6" />
                    </button>
                  </div>
                )}

                {isIslandExpanded && (
                  <div className="w-full flex justify-around px-4 items-center h-full">
                      <button className="flex flex-col items-center gap-1 text-slate-500 hover:text-indigo-600 transition-colors"
                        onClick={async () => {
                          setInputModal({
                              isOpen: true,
                              title: t.folderNamePrompt,
                              defaultValue: '',
                              onConfirm: async (name) => {
                                  if (!name) return;
                                  if (files.some(f => f.name === name)) {
                                      alert(t.folderExists);
                                      return;
                                  }
                                  try {
                                      // Ensure clean path construction
                                      const newPath = currentPath === '/' ? `/${name}` : `${currentPath}/${name}`;
                                      await api.createFolder(newPath, activeDrive);
                                      fetchFiles(currentPath);
                                      setIsIslandExpanded(false);
                                  } catch (err) { alert(t.createFolderFailed); }
                              }
                          });
                        }}
                      >
                        <FolderIcon className="w-6 h-6" />
                        <span className="text-[10px] font-medium">{t.folder}</span>
                      </button>
                      
                      <button 
                        className="flex flex-col items-center gap-1 text-slate-500 hover:text-indigo-600 transition-colors"
                        onClick={() => fileInputRef.current?.click()}
                      >
                        <CloudArrowUpIcon className="w-6 h-6" />
                        <span className="text-[10px] font-medium">{t.file}</span>
                      </button>
                      
                      <div className="w-px h-8 bg-slate-200"></div>

                      <button 
                        onClick={() => setIsIslandExpanded(false)}
                        className="flex flex-col items-center gap-1 text-red-400 hover:text-red-600 transition-colors"
                      >
                        <XMarkIcon className="w-6 h-6" />
                        <span className="text-[10px] font-medium">{t.close}</span>
                      </button>
                  </div>
                )}
              </>
            )}
          </motion.div>
        </div>

        <AnimatePresence>
            {inputModal.isOpen && (
                <InputModal
                    isOpen={inputModal.isOpen}
                    title={inputModal.title}
                    defaultValue={inputModal.defaultValue}
                    onConfirm={inputModal.onConfirm}
                    onClose={() => setInputModal(prev => ({ ...prev, isOpen: false }))}
                    lang={lang}
                />
            )}
        </AnimatePresence>

        <AnimatePresence>{previewFile && <div className="fixed inset-0 z-50"><PreviewModal file={{...previewFile, path: previewFile.path}} onClose={() => setPreviewFile(null)} drive={activeDrive} lang={lang} /></div>}</AnimatePresence>
        <AnimatePresence>{isAddDriveOpen && <div className="fixed inset-0 z-[60]"><AddDriveModal onClose={() => setIsAddDriveOpen(false)} onAdded={(newDrive) => {
          if (newDrive) {
            setDrives(prev => {
              const next = [...prev, newDrive];
              localStorage.setItem('cached_drives', JSON.stringify(next));
              return next;
            });
          }
        }} lang={lang} /></div>}</AnimatePresence>

        {/* Progress Toast */}
        <AnimatePresence>
            {progress && (
                <motion.div
                    initial={{ opacity: 0, y: 50 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 50 }}
                    className="fixed bottom-24 right-4 z-50 bg-slate-800 text-white px-4 py-3 rounded-xl shadow-2xl flex items-center gap-3 min-w-[200px] max-w-[300px]"
                >
                    <div className="relative w-8 h-8 shrink-0">
                        <svg className="w-full h-full -rotate-90" viewBox="0 0 36 36">
                            <path className="text-slate-600" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" fill="none" stroke="currentColor" strokeWidth="4" />
                            <path className="text-indigo-400 transition-all duration-300 ease-linear" strokeDasharray={`${(progress.current / progress.total) * 100}, 100`} d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" fill="none" stroke="currentColor" strokeWidth="4" />
                        </svg>
                        <div className="absolute inset-0 flex items-center justify-center text-[8px] font-bold">
                            {Math.round((progress.current / progress.total) * 100)}%
                        </div>
                    </div>
                    <div className="flex-1 min-w-0">
                        <p className="text-xs font-medium truncate">{progress.filename}</p>
                        <p className="text-[10px] text-slate-400">{progress.current} / {progress.total} items</p>
                    </div>
                </motion.div>
            )}
        </AnimatePresence>
      </div>
    </div>
  );
}

export default App;
