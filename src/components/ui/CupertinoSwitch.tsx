import React from 'react';

type CupertinoSwitchProps = {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  ariaLabel: string;
};

export const CupertinoSwitch: React.FC<CupertinoSwitchProps> = ({
  checked,
  onChange,
  disabled = false,
  ariaLabel,
}) => {
  return (
    <button
      type="button"
      role="switch"
      aria-label={ariaLabel}
      aria-checked={checked}
      className={`cupertino-switch ${checked ? 'on' : 'off'}`}
      onClick={() => {
        if (disabled) {
          return;
        }
        onChange(!checked);
      }}
      disabled={disabled}
    >
      <span className="cupertino-switch-thumb" />
    </button>
  );
};
