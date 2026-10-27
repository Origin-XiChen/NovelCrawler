import { House, LibraryBig, Server, UserRound } from 'lucide-react';
import { NavLink } from 'react-router-dom';

const items = [
  { to: '/home', label: '首页', icon: House },
  { to: '/shelf', label: '书架', icon: LibraryBig },
  { to: '/library', label: '电脑', icon: Server },
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
            <span className="bottom-nav__icon">
              <Icon size={21} strokeWidth={1.9} />
            </span>
            <span>{item.label}</span>
          </NavLink>
        );
      })}
    </nav>
  );
}
