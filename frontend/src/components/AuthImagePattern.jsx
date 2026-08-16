import { WaveMark } from "./WaveLogo";

const AuthImagePattern = ({ title, subtitle }) => {
  return (
    <div className="hidden lg:flex items-center justify-center bg-base-200 p-12">
      <div className="max-w-md text-center">
        <div className="grid grid-cols-3 gap-3 mb-8">
          {[...Array(9)].map((_, i) => {
            const row = Math.floor(i / 3);
            const col = i % 3;
            const delay = (row + col) * 180;
            return (
              <div
                key={i}
                className="group relative aspect-square overflow-hidden rounded-2xl bg-primary/10
                transition-all duration-300 ease-out hover:scale-105 hover:shadow-lg hover:shadow-primary/20"
              >
                <div
                  style={{ animationDelay: `${delay}ms` }}
                  className="absolute inset-0 bg-primary/20 animate-wave-shimmer motion-reduce:animate-none"
                />
                <WaveMark
                  className="absolute inset-0 m-auto h-1/2 w-auto scale-90 text-primary opacity-0
                  transition-all duration-300 ease-out group-hover:scale-100 group-hover:opacity-70"
                />
              </div>
            );
          })}
        </div>
        <h2 className="text-2xl font-bold mb-4">{title}</h2>
        <p className="text-base-content/60">{subtitle}</p>
      </div>
    </div>
  );
};

export default AuthImagePattern;
