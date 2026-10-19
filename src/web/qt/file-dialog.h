// SPDX-License-Identifier: GPL-2.0-or-later

#pragma once

#include <functional>
#include <QStringList>

class QWidget;

namespace Web::Qt {

void OpenFiles(QWidget* parent, const QStringList& extensions, bool multiple,
               std::function<void(const QStringList&)> completed);

} // namespace Web::Qt
