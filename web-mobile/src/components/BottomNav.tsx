import { LibraryBig, UserRound } from 'lucide-react';
import { NavLink } from 'react-router-dom';

const items = [
  { to: '/library', label: '书库', icon: LibraryBig },
  { to: '/settings', label: '我的', icon: UserRound },
];

export default function BottomNav() {
  return (
    <nav className="bottom-nav" aria-label="主导航">
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) => `bottom-nav__item${isActive ? ' is-active' : ''}`}
          >
            <Icon size={22} strokeWidth={1.9} />
            <span>{item.label}</span>
          </NavLink>
        );
      })}
    </nav>
  );
}
