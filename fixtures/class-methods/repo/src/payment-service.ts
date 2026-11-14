class PaymentService {
  process(amount: number) {
    function validate() {
      return amount > 0;
    }

    return validate();
  }
}

export function createPayment() {
  return new PaymentService().process(1);
}
