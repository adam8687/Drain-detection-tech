import dimensions from '../lib/design-assets.json';
// Preserve each exported SVG's natural bounds, including its baked-in shadows.
export default function DesignAsset({file,alt='',className}:{file:keyof typeof dimensions;alt?:string;className?:string}) {
  const size=dimensions[file];
  return <img src={`/images/design/${file}`} width={size.width} height={size.height} alt={alt} className={className} draggable={false} />;
}
