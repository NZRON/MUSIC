'use client';
import { Toaster as Sonner, ToasterProps } from 'sonner';
const Toaster = ({ theme = 'dark', ...props }: ToasterProps) => {
	return (
		<Sonner
			theme={theme}
			className="toaster group"
			style={
				{
					'--normal-bg': 'var[var(--popover)]',
					'--normal-text': 'var[var(--popover-foreground)]',
					'--normal-border': 'var[var(--border)]',
				} as React.CSSProperties
			}
			{...props}
		/>
	);
};
export { Toaster };
