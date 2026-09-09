import { ArrowRight } from 'lucide-react';

/* Animated action control shared by links and buttons. */
export function FlowButton({ children, variant = 'gold', className = '', href, ...props }) {
  // With an href this stays a real anchor rather than a button that calls
  // location: the comparison table's hire control navigates to another page,
  // and a button there would cost middle-click, copy-link and open-in-new-tab.
  const Tag = href ? 'a' : 'button';
  return (
    <Tag className={`flow-btn flow-${variant} ${className}`} {...(href ? { href } : {})} {...props}>
      {/* Enters from the left as the label makes room. */}
      <ArrowRight className="flow-arrow flow-arrow-in" size={15} strokeWidth={2} aria-hidden="true" />
      {/* The flood. Sized in CSS so it always covers, whatever the label. */}
      <span className="flow-circle" aria-hidden="true" />
      <span className="flow-label">{children}</span>
      {/* Leaves to the right as the first one arrives. */}
      <ArrowRight className="flow-arrow flow-arrow-out" size={15} strokeWidth={2} aria-hidden="true" />
    </Tag>
  );
}

export default FlowButton;
