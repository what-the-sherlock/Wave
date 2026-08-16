const SidebarSkeleton = () => {
  const skeletonChannels = Array(6).fill(null);

  return (
    <aside className="h-full w-64 shrink-0 border-r border-base-300 flex flex-col bg-base-100">
      <div className="border-b border-base-300 p-4">
        <div className="skeleton h-5 w-32" />
      </div>

      <div className="flex-1 overflow-y-auto py-2">
        <div className="px-3 py-1">
          <div className="skeleton h-3 w-16" />
        </div>
        <div className="px-1 py-1 space-y-1">
          {skeletonChannels.map((_, idx) => (
            <div key={idx} className="px-2 py-1.5 flex items-center gap-2">
              <div className="skeleton size-3.5 rounded-full shrink-0" />
              <div className="skeleton h-3 flex-1" />
            </div>
          ))}
        </div>
      </div>

      <div className="border-t border-base-300 p-2 flex gap-1">
        <div className="skeleton h-8 flex-1 rounded-lg" />
        <div className="skeleton h-8 flex-1 rounded-lg" />
      </div>
    </aside>
  );
};

export default SidebarSkeleton;
