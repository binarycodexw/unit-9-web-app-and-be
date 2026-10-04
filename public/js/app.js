// Form validation in the browser. It's only for convenience, the server checks everything again.

(function () {
  'use strict';

  function errorElementFor(field) {
    return field.id ? document.getElementById(field.id + '-error') : null;
  }

  function messageFor(field) {
    const v = field.validity;
    if (v.valueMissing) return 'This field is required.';
    if (v.typeMismatch && field.type === 'email') return 'Enter a valid email address, for example name@domain.com.';
    if (v.patternMismatch) return field.dataset.patternMessage || 'The value does not match the expected format.';
    if (v.tooShort) return 'Use at least ' + field.minLength + ' characters.';
    if (v.tooLong) return 'Use at most ' + field.maxLength + ' characters.';
    if (v.rangeUnderflow) return 'The value must be at least ' + field.min + '.';
    if (v.rangeOverflow) return 'The value must be at most ' + field.max + '.';
    if (v.badInput || v.stepMismatch) return 'Enter a valid number.';
    return field.validationMessage;
  }

  function checkMatch(field) {
    const otherName = field.dataset.match;
    if (!otherName) return true;
    const other = field.form.elements.namedItem(otherName);
    const ok = other && field.value === other.value;
    field.setCustomValidity(ok ? '' : 'The values do not match.');
    return ok;
  }

  function validateField(field) {
    checkMatch(field);
    const target = errorElementFor(field);
    const valid = field.checkValidity();
    field.setAttribute('aria-invalid', valid ? 'false' : 'true');
    if (target) {
      target.textContent = valid ? '' : field.dataset.match && field.validity.customError
        ? 'The passwords do not match.'
        : messageFor(field);
    }
    return valid;
  }

  document.querySelectorAll('form[data-validate]').forEach(function (form) {
    const fields = Array.from(form.elements).filter(function (el) {
      return el.name && el.type !== 'hidden' && el.type !== 'submit' && el.type !== 'button';
    });

    fields.forEach(function (field) {
      field.addEventListener('blur', function () { validateField(field); });
      field.addEventListener('input', function () {
        if (field.getAttribute('aria-invalid') === 'true') validateField(field);
      });
    });

    form.addEventListener('submit', function (event) {
      let firstInvalid = null;
      fields.forEach(function (field) {
        if (!validateField(field) && !firstInvalid) firstInvalid = field;
      });
      if (firstInvalid) {
        event.preventDefault();
        firstInvalid.focus();
        // no error element for this field (e.g. in a table row): use the browser bubble
        if (!errorElementFor(firstInvalid)) firstInvalid.reportValidity();
      }
    });
  });

  // ask before deleting
  document.addEventListener('click', function (event) {
    const button = event.target.closest('[data-confirm]');
    if (button && !window.confirm(button.dataset.confirm)) {
      event.preventDefault();
    }
  });
})();
