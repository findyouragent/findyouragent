/* Animated loading indicator for in-flight registry reads. */
export function WeaveSpinner({ size = 120, className = '' }) {
  return (
    <div
      className={`weave ${className}`}
      style={{ '--wv': `${size}px` }}
      aria-hidden="true"
    >
      <span className="weave-thread weave-t1" />
      <span className="weave-thread weave-t2" />
      <span className="weave-thread weave-t3" />
      <span className="weave-thread weave-t4" />
      <span className="weave-node" />
    </div>
  );
}

export default WeaveSpinner;
