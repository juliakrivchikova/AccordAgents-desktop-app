import { Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export function DeleteConfirmationDialog(props: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => Promise<void>;
}): JSX.Element {
  async function confirm(): Promise<void> {
    try {
      await props.onConfirm();
      props.onOpenChange(false);
    } catch {
      // The caller owns app-level error state. Keep this dialog open so a failed
      // delete cannot be mistaken for a successful one.
    }
  }

  return (
    <Dialog open={props.open} onOpenChange={(open) => {
      if (!props.pending) {
        props.onOpenChange(open);
      }
    }}>
      <DialogContent className="settings-delete-dialog" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{props.title}</DialogTitle>
          <DialogDescription>{props.description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline" size="sm" disabled={props.pending}>
              Cancel
            </Button>
          </DialogClose>
          <Button type="button" variant="destructive" size="sm" disabled={props.pending} onClick={() => void confirm()}>
            <Trash2 size={14} aria-hidden />
            {props.pending ? "Deleting..." : props.confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
