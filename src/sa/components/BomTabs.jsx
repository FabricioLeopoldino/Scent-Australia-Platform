import { Link, useLocation } from 'wouter';

// H3: one BOM section over the three existing pages (HYPER_UPDATE_BACKLOG.md H1.4).
// Each tab keeps its own address, page, table and permissions; nothing is merged.
export const BOM_TABS = [
  { path: '/bom', label: 'SA Product BOM' },
  { path: '/diffuser-bom', label: 'Diffuser BOM' },
  { path: '/formulas', label: 'Formulas' },
];

export const isBomPath = (location) => BOM_TABS.some((t) => location.startsWith(t.path));

export default function BomTabs() {
  const [location] = useLocation();
  return (
    <div className="container" style={{ paddingTop: 8 }}>
      <nav aria-label="Bill of Materials" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {BOM_TABS.map((t) => {
          const active = location.startsWith(t.path);
          return (
            <Link key={t.path} href={t.path} aria-current={active ? 'page' : undefined}
              className={active ? 'btn btn-primary' : 'btn btn-secondary'}
              style={{ fontSize: 12.5, padding: '7px 14px', textDecoration: 'none' }}>
              {t.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
