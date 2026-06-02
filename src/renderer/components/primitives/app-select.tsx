import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";

export interface AppSelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export function AppSelect(props: {
  value: string;
  options: AppSelectOption[];
  placeholder: string;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
  testId?: string;
  onValueChange: (value: string) => void;
}): JSX.Element {
  const selectedValue = props.value || undefined;
  return (
    <Select
      value={selectedValue}
      disabled={props.disabled}
      onValueChange={props.onValueChange}
    >
      <SelectTrigger className={`app-select-trigger ${props.className ?? ""}`} aria-label={props.ariaLabel ?? props.placeholder} data-testid={props.testId}>
        <SelectValue placeholder={props.placeholder} />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {props.options.map((option) => (
            <SelectItem value={option.value} disabled={option.disabled} key={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
